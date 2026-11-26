use std::{
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};
use windows_sys::Win32::System::{
    JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    Threading::CREATE_NO_WINDOW,
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const SAVE_GRACE: Duration = Duration::from_millis(2_500);
const LOG_LIMIT: u64 = 1024 * 1024;

pub struct Server {
    lifecycle: Mutex<Lifecycle>,
    closing: tokio::sync::watch::Sender<bool>,
    exiting: AtomicBool,
    started: Arc<AtomicBool>,
    log: Arc<Mutex<PathBuf>>,
}

#[derive(Default)]
struct Lifecycle {
    process: Option<Process>,
    updating: bool,
    draining_update: bool,
    restart_after_update: bool,
}

struct Process {
    child: Child,
    stdin: ChildStdin,
    // An unshared handle kills the whole tree even if the shell crashes.
    job: OwnedHandle,
    update_replies: Arc<Mutex<mpsc::Receiver<String>>>,
    update_id: u64,
}

pub enum InstallError {
    Busy,
    Failed,
}

impl Server {
    pub fn new(log_dir: PathBuf) -> Self {
        Self {
            lifecycle: Mutex::new(Lifecycle::default()),
            closing: tokio::sync::watch::channel(false).0,
            exiting: AtomicBool::new(false),
            started: Arc::new(AtomicBool::new(false)),
            log: Arc::new(Mutex::new(log_dir)),
        }
    }

    pub fn start(
        &self,
        runtime: &Path,
        screen_secret: &str,
    ) -> io::Result<mpsc::Receiver<io::Result<u16>>> {
        let mut lifecycle = self.lifecycle.lock().unwrap();
        if self.exiting() {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let job = create_job()?;
        let executable = std::env::current_exe()?;
        let mut child = Command::new(runtime.join("node.exe"))
            .env(
                "BITACORA_INSTALL_DIR",
                executable.parent().unwrap_or(runtime),
            )
            // Windows may return the resource directory in verbatim form.
            // Node resolves the entry relative to the working directory.
            .arg("server/index.mjs")
            .arg("--desktop")
            .current_dir(runtime)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
            let error = io::Error::last_os_error();
            let _ = child.kill();
            return Err(error);
        }
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (notify, ready) = mpsc::channel();
        let (update_reply, update_replies) = mpsc::channel();
        self.started.store(false, Ordering::Release);
        let started = Arc::clone(&self.started);
        thread::spawn(move || {
            let mut output = BufReader::new(stdout);
            let _ = notify.send(parse_ready(&mut output));
            // Keep consuming stdout after readiness, watching for the line that
            // says Codex started too.
            let mut line = Vec::new();
            while matches!(output.read_until(b'\n', &mut line), Ok(1..)) {
                if is_started(&line) {
                    started.store(true, Ordering::Release);
                } else if let Ok(message) = std::str::from_utf8(&line) {
                    if let Some(reply) = message.trim_end().strip_prefix("BITACORA_UPDATE ") {
                        let _ = update_reply.send(reply.to_owned());
                    }
                }
                line.clear();
            }
        });
        let log = Arc::clone(&self.log);
        thread::spawn(move || {
            let mut bytes = [0; 8192];
            while let Ok(size @ 1..) = stderr.read(&mut bytes) {
                append_log(&log, &bytes[..size]);
            }
        });
        // Only now can Node start Codex and let it spawn its helpers.
        stdin.write_all(format!("{screen_secret}\n").as_bytes())?;
        lifecycle.process = Some(Process {
            child,
            stdin,
            job,
            update_replies: Arc::new(Mutex::new(update_replies)),
            update_id: 0,
        });
        Ok(ready)
    }

    /// Whether this server process also got Codex running.
    pub fn started(&self) -> bool {
        self.started.load(Ordering::Acquire)
    }

    pub fn exiting(&self) -> bool {
        self.exiting.load(Ordering::Acquire)
    }

    pub fn running(&self) -> bool {
        let mut lifecycle = self.lifecycle.lock().unwrap();
        !self.exiting()
            && (lifecycle.updating || lifecycle.process.as_mut().is_some_and(Process::running))
    }

    pub fn take_update_restart(&self) -> bool {
        std::mem::take(&mut self.lifecycle.lock().unwrap().restart_after_update)
    }

    pub fn stop(&self) {
        let process = {
            let mut lifecycle = self.lifecycle.lock().unwrap();
            // RunEvent::Exit owns the normal shutdown, including the flush window.
            if self.exiting() || lifecycle.updating {
                return;
            }
            lifecycle.process.take()
        };
        if let Some(process) = process {
            self.drain_job(&process);
        }
    }

    /// Returns true when the worker must finish draining the job before the window closes.
    pub fn request_close(&self) -> bool {
        let lifecycle = self.lifecycle.lock().unwrap();
        self.exiting.store(true, Ordering::Release);
        self.closing.send_replace(true);
        lifecycle.draining_update
    }

    pub fn close_signal(&self) -> tokio::sync::watch::Receiver<bool> {
        self.closing.subscribe()
    }

    pub fn shutdown(&self) {
        self.request_close();
        let process = self.lifecycle.lock().unwrap().process.take();
        if let Some(Process {
            mut child,
            stdin,
            job,
            ..
        }) = process
        {
            drop(stdin);
            let deadline = Instant::now() + SAVE_GRACE;
            while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
                thread::sleep(Duration::from_millis(20));
            }
            drop(job);
        }
    }

    pub fn begin_update(&self) -> Result<(), InstallError> {
        let request = {
            let mut lifecycle = self.lifecycle.lock().unwrap();
            if self.exiting() || lifecycle.updating {
                return Err(InstallError::Failed);
            }
            let process = lifecycle.process.as_mut().ok_or(InstallError::Failed)?;
            if !process.running() {
                return Err(InstallError::Failed);
            }
            let request = process.send_update_command("BEGIN");
            lifecycle.updating = true;
            request
        };
        match request.and_then(UpdateRequest::reply) {
            Ok(reply) if reply == "READY" => Ok(()),
            Ok(reply) if reply == "BUSY" => {
                self.lifecycle.lock().unwrap().updating = false;
                Err(InstallError::Busy)
            }
            result => {
                self.log(&format!("No se pudo preparar la descarga: {result:?}"));
                self.cancel_update();
                Err(InstallError::Failed)
            }
        }
    }

    pub fn download_server_running(&self) -> bool {
        self.lifecycle
            .lock()
            .unwrap()
            .process
            .as_mut()
            .is_some_and(Process::running)
    }

    pub fn cancel_update(&self) {
        let request = {
            let mut lifecycle = self.lifecycle.lock().unwrap();
            if self.exiting() {
                lifecycle.updating = false;
                return;
            }
            lifecycle
                .process
                .as_mut()
                .map(|process| process.send_update_command("CANCEL"))
        };
        if request.is_some_and(|request| {
            request
                .and_then(UpdateRequest::reply)
                .is_ok_and(|reply| reply == "READY")
        }) {
            self.lifecycle.lock().unwrap().updating = false;
        } else if let Ok(process) = self.take_for_update() {
            self.drain_job(&process);
            drop(process);
            self.finish_update();
        }
    }

    fn take_for_update(&self) -> Result<Process, InstallError> {
        let mut lifecycle = self.lifecycle.lock().unwrap();
        if self.exiting() {
            lifecycle.updating = false;
            return Err(InstallError::Failed);
        }
        let Some(process) = lifecycle.process.take() else {
            lifecycle.updating = false;
            return Err(InstallError::Failed);
        };
        lifecycle.draining_update = true;
        Ok(process)
    }

    fn finish_update(&self) {
        let mut lifecycle = self.lifecycle.lock().unwrap();
        lifecycle.restart_after_update = !self.exiting();
        lifecycle.updating = false;
        lifecycle.draining_update = false;
    }

    pub fn install_update(
        &self,
        install: impl FnOnce() -> tauri_plugin_updater::Result<()>,
    ) -> Result<(), InstallError> {
        // The worker owns the process during the wait. The window thread can
        // request closure and the supervisor cannot start a second server.
        let mut process = self.take_for_update()?;
        let stopped = process.stop_for_update();
        self.drain_job(&process);
        drop(process);
        let result = if let Err(error) = stopped {
            self.log(&format!("No se pudo preparar la actualización: {error}"));
            Err(InstallError::Failed)
        } else if self.exiting() {
            Err(InstallError::Failed)
        } else {
            install().map_err(|error| {
                self.log(&format!("No se pudo iniciar el instalador: {error}"));
                InstallError::Failed
            })
        };
        self.finish_update();
        result
    }

    fn drain_job(&self, process: &Process) {
        // Keep ownership until Windows confirms every descendant is gone.
        let mut reported = false;
        let mut terminated = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match process.job_empty() {
                Ok(true) => return,
                Ok(false) => {}
                Err(error) if !reported => {
                    self.log(&format!(
                        "No pude comprobar el cierre de los procesos: {error}"
                    ));
                    reported = true;
                }
                Err(_) => {}
            }
            if !terminated {
                terminated = unsafe { TerminateJobObject(process.job.as_raw_handle(), 1) } != 0;
            }
            if !reported && Instant::now() >= deadline {
                self.log("Sigo esperando que Windows cierre los procesos anteriores.");
                reported = true;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn log(&self, message: &str) {
        append_log(&self.log, format!("{message}\n").as_bytes());
    }
}

struct UpdateRequest {
    id: u64,
    replies: Arc<Mutex<mpsc::Receiver<String>>>,
}

impl UpdateRequest {
    fn reply(self) -> io::Result<String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let prefix = format!("{} ", self.id);
        let replies = self.replies.lock().unwrap();
        loop {
            let reply = replies
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(io::Error::other)?;
            if let Some(reply) = reply.strip_prefix(&prefix) {
                return Ok(reply.to_owned());
            }
        }
    }
}

impl Process {
    fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn send_update_command(&mut self, command: &str) -> io::Result<UpdateRequest> {
        self.update_id += 1;
        writeln!(self.stdin, "BITACORA_UPDATE {} {command}", self.update_id)?;
        Ok(UpdateRequest {
            id: self.update_id,
            replies: Arc::clone(&self.update_replies),
        })
    }

    fn stop_for_update(&mut self) -> io::Result<()> {
        if self.send_update_command("INSTALL")?.reply()? != "STOPPING" {
            return Err(io::Error::other("Server did not accept update shutdown"));
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = self.child.try_wait()? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(io::Error::other(
                        "Server could not finish saving and closing",
                    ))
                };
            }
            if Instant::now() >= deadline {
                return Err(io::ErrorKind::TimedOut.into());
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn job_empty(&self) -> io::Result<bool> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(info.ActiveProcesses == 0)
    }
}

fn append_log(log_dir: &Mutex<PathBuf>, bytes: &[u8]) {
    let dir = log_dir.lock().unwrap();
    let path = dir.join("servidor.log");
    let write = || -> io::Result<()> {
        fs::create_dir_all(&*dir)?;
        if fs::metadata(&path).is_ok_and(|info| info.len() + bytes.len() as u64 > LOG_LIMIT) {
            let previous = dir.join("servidor.anterior.log");
            let _ = fs::remove_file(&previous);
            // Keep the active log bounded even if the previous one is locked.
            if fs::rename(&path, previous).is_err() {
                fs::File::create(&path)?;
            }
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?
            .write_all(bytes)
    };
    if let Err(error) = write() {
        eprintln!("Bitacora server log: {error}");
    }
}

fn create_job() -> io::Result<OwnedHandle> {
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&info) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

pub fn screen_secret() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        return Err(io::Error::other("Could not generate a screen session"));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn ready_port(ready: mpsc::Receiver<io::Result<u16>>) -> io::Result<u16> {
    ready
        .recv_timeout(STARTUP_TIMEOUT)
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => io::ErrorKind::TimedOut,
            mpsc::RecvTimeoutError::Disconnected => io::ErrorKind::UnexpectedEof,
        })?
}

fn is_started(line: &[u8]) -> bool {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line) == b"BITACORA_STARTED"
}

fn parse_ready(mut output: impl BufRead) -> io::Result<u16> {
    let mut line = Vec::new();
    while output.read_until(b'\n', &mut line)? != 0 {
        if let Ok(text) = std::str::from_utf8(&line) {
            if let Some(port) = text
                .trim_end_matches(['\r', '\n'])
                .strip_prefix("BITACORA_READY ")
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|port| *port != 0)
            {
                return Ok(port);
            }
        }
        line.clear();
    }
    Err(io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "Server stopped before startup",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_port_after_noise_and_leaves_the_rest_in_the_reader() {
        let mut output =
            &b"\xff\nBITACORA_READY 0\nBITACORA_READY 65536\r\nBITACORA_READY 43179\r\nmore\n"[..];
        assert_eq!(parse_ready(&mut output).unwrap(), 43179);
        assert_eq!(output, b"more\n");
    }

    #[test]
    fn recognizes_the_started_line() {
        assert!(is_started(b"BITACORA_STARTED\r\n"));
        assert!(is_started(b"BITACORA_STARTED\n"));
        assert!(!is_started(b"BITACORA_STARTED later\n"));
        assert!(!is_started(b"BITACORA_READY 43179\n"));
    }

    #[test]
    fn eof_without_a_port_is_a_startup_failure() {
        assert_eq!(
            parse_ready(&b"BITACORA_READY invalid\n"[..])
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}
