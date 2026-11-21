#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod folder_picker;
mod server;

use std::{
    io,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{webview::NewWindowResponse, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

use webview2_com::{
    take_pwstr, AddScriptToExecuteOnDocumentCreatedCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PermissionRequestedEventArgs3, ICoreWebView2_22, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
    },
    NavigationStartingEventHandler, PermissionRequestedEventHandler,
    WebResourceRequestedEventHandler,
};
use windows_core::{w, Interface, HSTRING};

const SPLASH: &str = "http://tauri.localhost/index.html";
const ERROR: &str = "http://tauri.localhost/error.html";
const CONNECTION_ERROR: &str = "http://tauri.localhost/error.html?reason=connection";
const VIEWER_ERROR: &str = "http://tauri.localhost/error.html?reason=viewer";

fn external_link(url: &Url) {
    if matches!(url.scheme(), "https" | "http") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

// Tauri's navigation hook covers the top-level page. The native PDF
// viewer can navigate a child frame without honoring the page's frame-src.
fn restrict_webview(
    webview: tauri::webview::PlatformWebview,
    window: tauri::WebviewWindow,
    endpoint: Arc<Mutex<Option<Url>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let frame_endpoint = Arc::clone(&endpoint);
    let permission_endpoint = Arc::clone(&endpoint);
    let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            let mut uri = Default::default();
            unsafe { args.Uri(&mut uri)? };
            let uri = take_pwstr(uri);
            let allowed = uri == "about:blank"
                || Url::parse(&uri).is_ok_and(|url| {
                    url.scheme() == "blob"
                        && frame_endpoint
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
        let env = webview.environment();
        let core = webview.controller().CoreWebView2()?;
        folder_picker::install(&core, window, Arc::clone(&endpoint))?;
        core.add_FrameNavigationStarting(&handler, &mut 0)?;
        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                let mut uri = Default::default();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                // The next server can get a different port. Never persist a grant.
                let transient = args
                    .cast::<ICoreWebView2PermissionRequestedEventArgs3>()
                    .is_ok_and(|profile| profile.SetSavesInProfile(false).is_ok());
                // The microphone for dictation, and several files at once for
                // "Descargar todas"; everything else (camera, location...) is denied.
                let allowed = (kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                    || kind == COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS)
                    && transient
                    && Url::parse(&uri).is_ok_and(|url| {
                        url.scheme() == "http"
                            && permission_endpoint
                                .lock()
                                .unwrap()
                                .as_ref()
                                .is_some_and(|local| url.origin() == local.origin())
                    });
                args.SetState(if allowed {
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW
                } else {
                    COREWEBVIEW2_PERMISSION_STATE_DENY
                })
            })),
            &mut 0,
        )?;
        // PDF links can start an HTTP document request before WebView2 emits
        // the navigation or new-window callback. Reject it before it goes out.
        let filter = w!("http*://*");
        if let Ok(core_22) = core.cast::<ICoreWebView2_22>() {
            core_22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                filter,
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            )?;
        } else {
            core.AddWebResourceRequestedFilter(filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT)?;
        }
        core.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = Default::default();
                args.Request()?.Uri(&mut uri)?;
                let allowed = Url::parse(&take_pwstr(uri)).is_ok_and(|url| {
                    url.origin() == Url::parse(SPLASH).unwrap().origin()
                        || endpoint
                            .lock()
                            .unwrap()
                            .as_ref()
                            .is_some_and(|local| url.origin() == local.origin())
                });
                if !allowed {
                    let response =
                        env.CreateWebResourceResponse(None, 403, w!("Forbidden"), w!(""))?;
                    args.SetResponse(&response)?;
                }
                Ok(())
            })),
            &mut 0,
        )?;
    }
    Ok(())
}

fn install_screen_script(
    window: &tauri::WebviewWindow,
    url: &Url,
    secret: &str,
    screen_script: Arc<Mutex<Option<String>>>,
) -> io::Result<()> {
    let origin = url.origin().ascii_serialization();
    let script = format!(
        "if (window === window.top && location.origin === '{origin}') {{
            Object.defineProperty(window, '__BITACORA_SCREEN_SECRET__', {{ value: '{secret}' }});
        }}"
    );
    let (notify, ready) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let installed = notify.clone();
            let result = (|| unsafe {
                let core = webview.controller().CoreWebView2()?;
                {
                    let mut previous_script = screen_script.lock().unwrap();
                    if let Some(id) = previous_script.as_deref() {
                        core.RemoveScriptToExecuteOnDocumentCreated(&HSTRING::from(id))?;
                        *previous_script = None;
                    }
                }
                core.AddScriptToExecuteOnDocumentCreated(
                    &HSTRING::from(script),
                    &AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(
                        move |status, id| {
                            let result = status.map(|()| {
                                *screen_script.lock().unwrap() = Some(id);
                            });
                            let _ = installed.send(result.map_err(io::Error::other));
                            Ok(())
                        },
                    )),
                )
            })();
            if let Err(error) = result {
                let _ = notify.send(Err(io::Error::other(error)));
            }
        })
        .map_err(io::Error::other)?;
    ready
        .recv_timeout(Duration::from_secs(10))
        .map_err(io::Error::other)?
}

fn supervise(
    server: Arc<server::Server>,
    window: tauri::WebviewWindow,
    runtime: PathBuf,
    endpoint: Arc<Mutex<Option<Url>>>,
    reopen: mpsc::Receiver<()>,
) {
    let mut has_connected = false;
    let screen_script = Arc::new(Mutex::new(None));
    while !server.exiting() {
        let mut retried_start = false;
        let mut recovering = false;
        while !server.exiting() {
            let result = (|| {
                let secret = server::screen_secret()?;
                let port = server::ready_port(server.start(&runtime, &secret)?)?;
                let url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
                install_screen_script(
                    &window,
                    &url,
                    &secret,
                    Arc::clone(&screen_script),
                )?;
                Ok::<_, io::Error>(url)
            })();
            if server.exiting() {
                return;
            }
            let retry = if let Ok(url) = result {
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
                // Only a server that got Codex running counts as a connection to
                // lose; before that, a failure is a failed start.
                has_connected |= server.started();
                if !server.exiting() {
                    server.log("El servidor se cerró.");
                }
                let retry = !recovering;
                recovering = true;
                retry
            } else {
                let error = result.unwrap_err();
                server.log(&format!("No se pudo iniciar el servidor: {error}"));
                let retry =
                    !recovering && !retried_start && error.kind() != std::io::ErrorKind::TimedOut;
                retried_start = true;
                retry
            };
            *endpoint.lock().unwrap() = None;
            server.stop();
            if server.exiting() {
                return;
            }
            if !retry {
                break;
            }
            let _ = window.navigate(Url::parse(SPLASH).unwrap());
        }
        while reopen.try_recv().is_ok() {}
        let error_page = if has_connected {
            CONNECTION_ERROR
        } else {
            ERROR
        };
        let _ = window.navigate(Url::parse(error_page).unwrap());
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
        .plugin(tauri_plugin_dialog::init())
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
                if let Err(error) =
                    restrict_webview(webview, worker_window.clone(), Arc::clone(&endpoint))
                {
                    server.log(&format!("No se pudo proteger el visor: {error}"));
                    let _ = worker_window.navigate(Url::parse(VIEWER_ERROR).unwrap());
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
