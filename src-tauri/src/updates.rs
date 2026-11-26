use crate::server::{InstallError, Server};
use std::{
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{Config, Url, WebviewWindow};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use webview2_com::{
    take_pwstr, Microsoft::Web::WebView2::Win32::ICoreWebView2, WebMessageReceivedEventHandler,
};
use windows_core::HSTRING;

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Copy)]
enum Notice {
    Available,
    Busy,
    Failed,
}

enum Status {
    Idle,
    Available(Box<Update>, Notice),
    Working,
}

struct Updates {
    window: WebviewWindow,
    endpoint: Arc<Mutex<Option<Url>>>,
    server: Arc<Server>,
    status: Mutex<Status>,
}

impl Updates {
    fn publish(self: &Arc<Self>) {
        let updates = Arc::clone(self);
        let _ = self.window.with_webview(move |webview| {
            let _ = (|| unsafe {
                let core = webview.controller().CoreWebView2()?;
                let mut source = Default::default();
                core.Source(&mut source)?;
                if updates.is_screen(&take_pwstr(source)) {
                    let state = match &*updates.status.lock().unwrap() {
                        Status::Idle => "idle",
                        Status::Available(_, Notice::Available) => "available",
                        Status::Available(_, Notice::Busy) => "busy",
                        Status::Available(_, Notice::Failed) => "failed",
                        Status::Working => "working",
                    };
                    core.PostWebMessageAsString(&HSTRING::from(format!(
                        "bitacora:update:{state}"
                    )))?;
                }
                windows_core::Result::Ok(())
            })();
        });
    }

    fn is_screen(&self, source: &str) -> bool {
        let source = Url::parse(source).ok();
        self.endpoint
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|local| Some(local) == source.as_ref())
    }

    fn check_periodically(self: Arc<Self>) {
        let updater = match make_updater(&self.window) {
            Ok(updater) => updater,
            Err(error) => {
                self.server
                    .log(&format!("No se pudo preparar el actualizador: {error}"));
                return;
            }
        };
        while !self.server.exiting() {
            if let Ok(available) = tauri::async_runtime::block_on(updater.check()) {
                let mut status = self.status.lock().unwrap();
                if !matches!(*status, Status::Working) {
                    *status = available.map_or(Status::Idle, |update| {
                        Status::Available(Box::new(update), Notice::Available)
                    });
                }
                drop(status);
                self.publish();
            }
            thread::sleep(CHECK_INTERVAL);
        }
    }

    fn start_install(self: &Arc<Self>) {
        let mut status = self.status.lock().unwrap();
        if !matches!(*status, Status::Available(..)) {
            return;
        }
        let Status::Available(mut update, _) = std::mem::replace(&mut *status, Status::Working)
        else {
            unreachable!()
        };
        drop(status);
        self.publish();
        let updates = Arc::clone(self);
        // The installer includes the complete runtime, so let slow connections
        // take longer than the short metadata check.
        update.timeout = Some(Duration::from_secs(30 * 60));
        thread::spawn(move || {
            let notice = match tauri::async_runtime::block_on(update.download(|_, _| {}, || {})) {
                Ok(bytes) => match updates.server.install_update(|| update.install(bytes)) {
                    Err(InstallError::Busy) => Notice::Busy,
                    Err(InstallError::Failed) | Ok(()) => Notice::Failed,
                },
                Err(error) => {
                    updates
                        .server
                        .log(&format!("No se pudo descargar la actualización: {error}"));
                    Notice::Failed
                }
            };
            *updates.status.lock().unwrap() = Status::Available(update, notice);
            updates.publish();
        });
    }
}

fn loopback_http(endpoint: &Url) -> bool {
    endpoint.scheme() == "http"
        && matches!(
            endpoint.host_str(),
            Some("127.0.0.1" | "[::1]" | "localhost")
        )
}

fn override_endpoint() -> Result<Option<Url>, Box<dyn std::error::Error>> {
    let Some(value) = std::env::var_os("BITACORA_UPDATE_ENDPOINT") else {
        return Ok(None);
    };
    let endpoint = Url::parse(value.to_str().ok_or("Invalid update endpoint")?)?;
    if endpoint.scheme() != "https" && !loopback_http(&endpoint) {
        return Err("The update endpoint must use HTTPS or be local".into());
    }
    Ok(Some(endpoint))
}

pub fn configure(config: &mut Config) {
    if override_endpoint().is_ok_and(|endpoint| endpoint.as_ref().is_some_and(loopback_http)) {
        if let Some(updater) = config.plugins.0.get_mut("updater") {
            updater["dangerousInsecureTransportProtocol"] = true.into();
        }
    }
}

fn make_updater(window: &WebviewWindow) -> Result<Updater, Box<dyn std::error::Error>> {
    let mut builder = window.updater_builder();
    if let Some(endpoint) = override_endpoint()? {
        if loopback_http(&endpoint) {
            builder = builder.no_proxy();
        }
        builder = builder.endpoints(vec![endpoint])?;
    }
    // The Rust shell drains the process tree first. Tauri exits on successful
    // Windows installer launch; keep the window visible if launch fails.
    Ok(builder
        .on_before_exit(|| {})
        .timeout(Duration::from_secs(15))
        .build()?)
}

pub fn install(
    core: &ICoreWebView2,
    window: WebviewWindow,
    endpoint: Arc<Mutex<Option<Url>>>,
    server: Arc<Server>,
) -> windows_core::Result<()> {
    let updates = Arc::new(Updates {
        window,
        endpoint,
        server,
        status: Mutex::new(Status::Idle),
    });
    let handler = Arc::clone(&updates);
    unsafe {
        core.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut source = Default::default();
                args.Source(&mut source)?;
                if !handler.is_screen(&take_pwstr(source)) {
                    return Ok(());
                }
                let mut message = Default::default();
                if args.TryGetWebMessageAsString(&mut message).is_ok() {
                    match take_pwstr(message).as_str() {
                        "bitacora:update:status" => handler.publish(),
                        "bitacora:update:install" => handler.start_install(),
                        _ => {}
                    }
                }
                Ok(())
            })),
            &mut 0,
        )?;
    }
    thread::spawn(move || updates.check_periodically());
    Ok(())
}
