//! Reloads the main window when its WebView2 renderer process dies. Without this a renderer
//! crash leaves the window blank and unresponsive until the app is restarted.

/// A page that keeps crashing on load is left alone after this many reloads in `WINDOW`.
#[cfg(windows)]
const MAX_RELOADS: usize = 3;
#[cfg(windows)]
const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.with_webview(|webview| {
        #[cfg(windows)]
        webview2::watch(webview.controller());
        #[cfg(not(windows))]
        let _ = webview;
    });
}

#[cfg(windows)]
mod webview2 {
    use super::{MAX_RELOADS, WINDOW};
    use std::time::Instant;
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, ProcessFailedEventHandler};

    /// Runs on the UI thread, where WebView2 also raises ProcessFailed.
    pub(super) fn watch(controller: ICoreWebView2Controller) {
        let mut reloads: Vec<Instant> = Vec::new();
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let (Some(webview), Some(args)) = (sender, args) else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            unsafe { args.ProcessFailedKind(&mut kind)? };
            // An unresponsive renderer may still recover by itself; only a dead one is replaced.
            if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                return Ok(());
            }
            reloads.retain(|at| at.elapsed() < WINDOW);
            if reloads.len() >= MAX_RELOADS {
                eprintln!("[renderer] the page crashed {MAX_RELOADS} times within a minute; not reloading again");
                return Ok(());
            }
            reloads.push(Instant::now());
            eprintln!("[renderer] the WebView2 renderer exited; reloading the window");
            unsafe { webview.Reload() }
        }));
        let mut token = 0i64;
        let _ = (|| unsafe { controller.CoreWebView2()?.add_ProcessFailed(&handler, &mut token) })();
    }
}
