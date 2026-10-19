//! Keeps Epigraph running in the notification area when the main window is closed, and shows
//! native notifications for background results while the window is out of sight.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewWindow,
};
use tauri_plugin_notification::NotificationExt;

const TRAY_ID: &str = "epigraph-tray";
const MENU_OPEN: &str = "epigraph-tray-open";
const MENU_QUIT: &str = "epigraph-tray-quit";
const MAX_LABEL_CHARS: usize = 40;
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 300;

static CLOSE_TO_BACKGROUND: AtomicBool = AtomicBool::new(false);

/// True when closing the main window should hide it instead of quitting.
pub fn closes_to_background() -> bool {
    CLOSE_TO_BACKGROUND.load(Ordering::Acquire)
}

/// Turns close-to-background on or off. The tray icon exists only while it is on, so the app
/// never lingers in the notification area unless the user asked for it.
#[tauri::command]
pub fn set_close_to_background(
    app: AppHandle,
    enabled: bool,
    open_label: String,
    quit_label: String,
) -> Result<(), String> {
    CLOSE_TO_BACKGROUND.store(enabled, Ordering::Release);
    if !enabled {
        let _ = app.remove_tray_by_id(TRAY_ID);
        // A hidden window with no tray icon could not be reached again.
        if let Some(window) = main_window(&app) {
            if !window.is_visible().unwrap_or(true) {
                show_main_window(&app);
            }
        }
        return Ok(());
    }
    let open_label = clip(&open_label, MAX_LABEL_CHARS, "Open Epigraph");
    let quit_label = clip(&quit_label, MAX_LABEL_CHARS, "Quit");
    let open = MenuItem::with_id(&app, MENU_OPEN, open_label, true, None::<&str>).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, MENU_QUIT, quit_label, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&open, &quit]).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        return tray.set_menu(Some(menu)).map_err(|e| e.to_string());
    }
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Epigraph")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_main_window(app),
            MENU_QUIT => crate::request_owned_desktop_shutdown(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(&app).map(|_| ()).map_err(|e| e.to_string())
}

/// Shows a native notification only while the main window is hidden, minimized or unfocused;
/// in front of the user the in-app toast already says the same. Returns whether it was shown.
#[tauri::command]
pub fn show_background_notification(app: AppHandle, title: String, body: Option<String>) -> Result<bool, String> {
    let Some(window) = main_window(&app) else { return Ok(false) };
    if !is_out_of_sight(&window) {
        return Ok(false);
    }
    let title = clip(&title, MAX_TITLE_CHARS, "Epigraph");
    let mut notification = app.notification().builder().title(title);
    if let Some(body) = body.as_deref().map(str::trim).filter(|body| !body.is_empty()) {
        notification = notification.body(clip(body, MAX_BODY_CHARS, ""));
    }
    notification.show().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Hides the main window instead of closing it. Returns false when the app should quit.
pub fn hide_on_close(window: &tauri::Window) -> bool {
    if !closes_to_background() || window.app_handle().tray_by_id(TRAY_ID).is_none() {
        return false;
    }
    window.hide().is_ok()
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(crate::MAIN_WINDOW_LABEL)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn is_out_of_sight(window: &WebviewWindow) -> bool {
    !window.is_visible().unwrap_or(true)
        || window.is_minimized().unwrap_or(false)
        || !window.is_focused().unwrap_or(true)
}

fn clip(value: &str, max_chars: usize, fallback: &str) -> String {
    let value = value.trim();
    let value = if value.is_empty() { fallback } else { value };
    match value.char_indices().nth(max_chars) {
        Some((end, _)) => format!("{}…", value[..end].trim_end()),
        None => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_trimmed_clipped_and_never_empty() {
        assert_eq!(clip("  Abrir  ", 40, "Open"), "Abrir");
        assert_eq!(clip("   ", 40, "Open"), "Open");
        assert_eq!(clip("Atualizações", 5, ""), "Atual…");
        assert_eq!(clip("新しい章があります", 3, ""), "新しい…");
    }
}
