#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use std::{
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{webview::NewWindowResponse, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

use webview2_com::{take_pwstr, NavigationStartingEventHandler};

const SPLASH: &str = "http://tauri.localhost/index.html";
const ERROR: &str = "http://tauri.localhost/error.html";

fn external_link(url: &Url) {
    if matches!(url.scheme(), "https" | "http") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

// Tauri's navigation hook covers the top-level page. The native PDF
// viewer can navigate a child frame without honoring the page's frame-src.
fn restrict_frames(
    webview: tauri::webview::PlatformWebview,
    endpoint: Arc<Mutex<Option<Url>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            let mut uri = Default::default();
            unsafe { args.Uri(&mut uri)? };
            let uri = take_pwstr(uri);
            let allowed = uri == "about:blank"
                || Url::parse(&uri).is_ok_and(|url| {
                    url.scheme() == "blob"
                        && endpoint
                            .lock()
                            .unwrap()
                            .as_ref()
                            .is_some_and(|local| url.origin() == local.origin())
                });
            if !allowed {
                unsafe { args.SetCancel(true)? };
            }
        }
        Ok(())
    }));
    unsafe {
        webview
            .controller()
            .CoreWebView2()?
            .add_FrameNavigationStarting(&handler, &mut 0)?;
    }
    Ok(())
}

fn supervise(
    server: Arc<server::Server>,
    window: tauri::WebviewWindow,
    runtime: PathBuf,
    endpoint: Arc<Mutex<Option<Url>>>,
    reopen: mpsc::Receiver<()>,
) {
    while !server.exiting() {
        for attempt in 0..2 {
            if server.exiting() {
                return;
            }
            let result = server.start(&runtime).and_then(server::ready_port);
            if server.exiting() {
                return;
            }
            if let Ok(port) = result {
                let url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
                *endpoint.lock().unwrap() = Some(url.clone());
                let _ = window.navigate(url);
                while server.running() {
                    match reopen.recv_timeout(Duration::from_millis(100)) {
                        Ok(()) => {
                            let _ =
                                window.eval("window.dispatchEvent(new Event('bitacora-reopen'))");
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                if !server.exiting() {
                    server.log("El servidor se cerró.");
                }
            } else if let Err(error) = &result {
                server.log(&format!("No se pudo iniciar el servidor: {error}"));
            }
            *endpoint.lock().unwrap() = None;
            server.stop();
            if server.exiting() {
                return;
            }
            if attempt == 1
                || result.is_err_and(|error| error.kind() == std::io::ErrorKind::TimedOut)
            {
                break;
            }
            let _ = window.navigate(Url::parse(SPLASH).unwrap());
        }
        while reopen.try_recv().is_ok() {}
        let _ = window.navigate(Url::parse(ERROR).unwrap());
        if reopen.recv().is_err() || server.exiting() {
            return;
        }
        let _ = window.navigate(Url::parse(SPLASH).unwrap());
    }
}

fn run() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if let Some(reopen) = app.try_state::<mpsc::Sender<()>>() {
                let _ = reopen.send(());
            }
        }))
        .setup(|app| {
            let endpoint = Arc::new(Mutex::new(None::<Url>));
            let navigation_endpoint = Arc::clone(&endpoint);
            let (reopen, requests) = mpsc::channel();
            app.manage(reopen);
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Bitácora")
                    .inner_size(1280.0, 840.0)
                    .min_inner_size(420.0, 560.0)
                    .disable_drag_drop_handler()
                    .initialization_script(
                        "Object.defineProperty(window, '__BITACORA_DESKTOP__', { value: true });",
                    )
                    .on_navigation(move |url| {
                        if navigation_endpoint
                            .lock()
                            .unwrap()
                            .as_ref()
                            .is_some_and(|endpoint| url.origin() == endpoint.origin())
                            || (url.scheme() == "http"
                                && url.host_str() == Some("tauri.localhost")
                                && url.port().is_none()
                                && matches!(url.path(), "/" | "/index.html" | "/error.html"))
                        {
                            return true;
                        }
                        external_link(url);
                        false
                    })
                    .on_new_window(|url, _| {
                        external_link(&url);
                        NewWindowResponse::Deny
                    })
                    .build()?;

            let runtime = app.path().resource_dir()?.join("runtime");
            let data = match std::env::var_os("BITACORA_DATA_DIR") {
                Some(path) if !path.is_empty() => PathBuf::from(path),
                _ => app.path().data_dir()?.join("Bitacora"),
            };
            let server = Arc::new(server::Server::new(data.join("logs")));
            app.manage(Arc::clone(&server));
            let worker_window = window.clone();
            window.with_webview(move |webview| {
                if let Err(error) = restrict_frames(webview, Arc::clone(&endpoint)) {
                    server.log(&format!("No se pudo proteger el visor: {error}"));
                    let _ = worker_window.navigate(Url::parse(ERROR).unwrap());
                    return;
                }
                std::thread::spawn(move || {
                    supervise(server, worker_window, runtime, endpoint, requests)
                });
            })?;
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(server) = app.try_state::<Arc<server::Server>>() {
                server.shutdown();
            }
        }
    });
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Bitacora: {error}");
    }
}
