use std::{
    io::{self, BufRead, BufReader, Write},
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::System::{
    JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    Threading::CREATE_NO_WINDOW,
};

pub struct Server(Mutex<Option<Process>>);

struct Process {
    child: Child,
    stdin: ChildStdin,
    // An unshared handle kills the whole tree even if the shell crashes.
    job: OwnedHandle,
}

impl Server {
    pub fn start(runtime: &Path) -> io::Result<(Self, ChildStdout)> {
        let job = create_job()?;
        let mut child = Command::new(runtime.join("node.exe"))
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
            .spawn()?;

        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
            let error = io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        // Only now can Node start Codex and let it spawn its helpers.
        stdin.write_all(b"\n")?;
        Ok((
            Self(Mutex::new(Some(Process { child, stdin, job }))),
            stdout,
        ))
    }

    pub fn stop(&self) {
        let Some(Process {
            mut child,
            stdin,
            job,
        }) = self.0.lock().unwrap().take()
        else {
            return;
        };
        drop(stdin);
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
            thread::sleep(Duration::from_millis(50));
        }
        drop(job);
        let _ = child.wait();
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

pub fn ready_port(stdout: ChildStdout) -> io::Result<u16> {
    for line in BufReader::new(stdout).lines() {
        if let Some(port) = line?
            .strip_prefix("BITACORA_READY ")
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port != 0)
        {
            return Ok(port);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "Server stopped before startup",
    ))
}
