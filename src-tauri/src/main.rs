#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use std::sync::{Arc, Mutex};
use tauri::{webview::NewWindowResponse, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

fn external_link(url: &Url) {
    if matches!(url.scheme(), "https" | "http") {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

fn run() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let endpoint = Arc::new(Mutex::new(None::<Url>));
            let navigation_endpoint = Arc::clone(&endpoint);
            let popup_endpoint = Arc::clone(&endpoint);
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
                        let local = navigation_endpoint.lock().unwrap();
                        if local
                            .as_ref()
                            .is_some_and(|endpoint| url.origin() == endpoint.origin())
                            || (url.scheme() == "http"
                                && url.host_str() == Some("tauri.localhost")
                                && url.port().is_none()
                                && matches!(url.path(), "/" | "/index.html" | "/error.html"))
                        {
                            return true;
                        }
                        drop(local);
                        external_link(url);
                        false
                    })
                    .on_new_window(move |url, _| {
                        if url.scheme() == "blob"
                            && popup_endpoint
                                .lock()
                                .unwrap()
                                .as_ref()
                                .is_some_and(|endpoint| url.origin() == endpoint.origin())
                        {
                            // The WebView2 PDF viewer needs the same profile as the
                            // parent window to resolve its in-memory object URL.
                            return NewWindowResponse::Allow;
                        }
                        external_link(&url);
                        NewWindowResponse::Deny
                    })
                    .build()?;

            let runtime = app.path().resource_dir()?.join("runtime");
            match server::Server::start(&runtime) {
                Ok((server, output)) => {
                    app.manage(server);
                    std::thread::spawn(move || {
                        if let Ok(port) = server::ready_port(output) {
                            let url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
                            *endpoint.lock().unwrap() = Some(url.clone());
                            let _ = window.navigate(url);
                        } else {
                            let _ = window
                                .navigate(Url::parse("http://tauri.localhost/error.html").unwrap());
                        }
                    });
                }
                Err(error) => {
                    eprintln!("Bitacora server: {error}");
                    window.navigate(Url::parse("http://tauri.localhost/error.html").unwrap())?;
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            if let Some(server) = app.try_state::<server::Server>() {
                server.stop();
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
