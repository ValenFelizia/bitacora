use std::sync::{Arc, Mutex};
use tauri::{Url, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use webview2_com::{
    take_pwstr, Microsoft::Web::WebView2::Win32::ICoreWebView2, WebMessageReceivedEventHandler,
};
use windows_core::HSTRING;

const REQUEST: &str = "bitacora:pick-folder:";
const RESPONSE: &str = "bitacora:folder:";

// Only the running app's top document can open the picker and receive its
// result. There is no Tauri IPC capability granted to loopback origins.
pub fn install(
    core: &ICoreWebView2,
    window: WebviewWindow,
    endpoint: Arc<Mutex<Option<Url>>>,
) -> windows_core::Result<()> {
    unsafe {
        core.add_WebMessageReceived(
            &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut source = Default::default();
                args.Source(&mut source)?;
                let Ok(source) = Url::parse(&take_pwstr(source)) else {
                    return Ok(());
                };
                if !endpoint
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|local| source == *local)
                {
                    return Ok(());
                }

                let mut message = Default::default();
                if args.TryGetWebMessageAsString(&mut message).is_err() {
                    return Ok(());
                }
                let message = take_pwstr(message);
                let Some(request) = message.strip_prefix(REQUEST) else {
                    return Ok(());
                };
                if request.len() != 36
                    || !request.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
                {
                    return Ok(());
                }

                let request = request.to_owned();
                let reply = window.clone();
                window
                    .dialog()
                    .file()
                    .set_parent(&window)
                    .set_title("Elegí tu carpeta de trabajo")
                    .pick_folder(move |folder| {
                        let path = folder.and_then(|folder| folder.into_path().ok());
                        let response = format!(
                            "{RESPONSE}{request}:{}",
                            path.as_deref().and_then(|path| path.to_str()).unwrap_or("")
                        );
                        let _ = reply.with_webview(move |webview| {
                            let _ = (|| -> windows_core::Result<()> {
                                let core = webview.controller().CoreWebView2()?;
                                let mut current = Default::default();
                                core.Source(&mut current)?;
                                if Url::parse(&take_pwstr(current)).ok().as_ref() == Some(&source) {
                                    core.PostWebMessageAsString(&HSTRING::from(response))?;
                                }
                                Ok(())
                            })();
                        });
                    });
                Ok(())
            })),
            &mut 0,
        )
    }
}
