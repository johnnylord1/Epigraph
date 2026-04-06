use std::borrow::Cow;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, mpsc};
use base64::Engine;
use percent_encoding::percent_decode;
use tauri::http::{header::CONTENT_TYPE, Request, Response, StatusCode};
use sysinfo::{Disks, Pid, System};
use serde::Serialize;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_shell::{ShellExt, process::CommandChild};
use walkdir::WalkDir;

const READER_WEBVIEW_INIT_SCRIPT: &str = r#"
(() => {
  const SAME_ORIGIN = location.origin;
  const SAME_HOST = location.hostname;
  const AD_HOST_RE = /doubleclick|googlesyndication|googleadservices|adsystem|adnxs|taboola|outbrain|exoclick|popads|propellerads|adsterra|trafficjunky|juicyads|hilltopads|clickadu|onesignal|histats|analytics/i;
  const AD_ATTR_RE = /(ad-|ads-|_ad|banner|popup|popunder|sticky-ad|advert|sponsor|promo)/i;
  const AD_STYLE_ID = "aethon-reader-webview-cleanup";
  const SELECTORS = [
    "iframe[src*='doubleclick']",
    "iframe[src*='googlesyndication']",
    "iframe[src*='googleadservices']",
    "iframe[src*='adnxs']",
    "iframe[src*='taboola']",
    "iframe[src*='outbrain']",
    "iframe[id*='google_ads']",
    "iframe[class*='ads']",
    ".adsbygoogle",
    "[id*='banner']",
    "[class*='banner']",
    "[id*='popup']",
    "[class*='popup']",
    "[id*='advert']",
    "[class*='advert']",
    "[id*='sponsor']",
    "[class*='sponsor']"
  ];

  function installCss() {
    if (document.getElementById(AD_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = AD_STYLE_ID;
    style.textContent = `
      ${SELECTORS.join(",\n")} {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function isAdLikeElement(el) {
    if (!(el instanceof HTMLElement)) return false;
    const attrs = `${el.id} ${el.className} ${el.getAttribute("role") ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
    if (AD_ATTR_RE.test(attrs)) return true;
    const iframe = el.querySelector("iframe");
    if (iframe instanceof HTMLIFrameElement && AD_HOST_RE.test(iframe.src || "")) return true;
    const style = window.getComputedStyle(el);
    const z = Number.parseInt(style.zIndex || "0", 10);
    if (style.position === "fixed" && z >= 1000 && (AD_ATTR_RE.test(attrs) || iframe)) return true;
    return false;
  }

  function clean(root = document) {
    if (!(root instanceof Document || root instanceof HTMLElement || root instanceof DocumentFragment)) return;
    root.querySelectorAll?.("*").forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      if (isAdLikeElement(node)) node.remove();
      if (node instanceof HTMLIFrameElement && AD_HOST_RE.test(node.src || "")) node.remove();
    });
  }

  function clampLinks(root = document) {
    root.querySelectorAll?.("a[target='_blank']").forEach((node) => {
      if (!(node instanceof HTMLAnchorElement)) return;
      try {
        const url = new URL(node.href, location.href);
        if (url.hostname === SAME_HOST) {
          node.target = "_self";
          return;
        }
        if (AD_HOST_RE.test(url.hostname)) {
          node.removeAttribute("href");
          node.style.pointerEvents = "none";
        }
      } catch {}
    });
  }

  const originalOpen = window.open;
  window.open = function(url, target, features) {
    try {
      const next = new URL(String(url || ""), location.href);
      if (next.hostname === SAME_HOST) {
        location.assign(next.toString());
        return null;
      }
      if (AD_HOST_RE.test(next.hostname)) {
        return null;
      }
    } catch {}
    return null;
  };

  installCss();
  clean();
  clampLinks();
  document.addEventListener("DOMContentLoaded", () => {
    installCss();
    clean();
    clampLinks();
  }, { once: true });
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement || node instanceof DocumentFragment) {
          clean(node);
          clampLinks(node);
        }
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
"#;

struct RunningServer {
    child: CommandChild,
    lock_path: PathBuf,
}

struct ServerState(Mutex<Option<RunningServer>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchTargetInfo {
  server_url_override: Option<String>,
  profile_label_override: Option<String>,
}

struct LaunchTarget(LaunchTargetInfo);

#[derive(Serialize)]
pub struct StorageInfo {
    manga_bytes: u64,
    total_bytes: u64,
    free_bytes:  u64,
    path:        String,
}

#[derive(Serialize, Debug)]
#[serde(tag = "kind", content = "message")]
pub enum SpawnError {
    NotConfigured(String),
    SpawnFailed(String),
}

#[tauri::command]
async fn open_reader_webview(app: tauri::AppHandle, url: String, title: Option<String>) -> Result<(), String> {
    let parsed = url::Url::parse(url.trim()).map_err(|e| e.to_string())?;
    let window_title = title.unwrap_or_else(|| "Chapter Web View".to_string());
    let reader_host = parsed.host_str().map(str::to_owned);
    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let label = "reader-webview";

            if let Some(window) = handle.get_webview_window(label) {
                let _ = window.destroy();
            }

            let window = tauri::WebviewWindowBuilder::new(
                &handle,
                label,
                tauri::WebviewUrl::External(parsed),
            )
            .title(window_title)
            .initialization_script(READER_WEBVIEW_INIT_SCRIPT)
            .on_navigation({
                let reader_host = reader_host.clone();
                move |next_url| is_allowed_reader_navigation(reader_host.as_deref(), next_url)
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .inner_size(1280.0, 900.0)
            .min_inner_size(960.0, 700.0)
            .resizable(true)
            .focused(true)
            .build()
            .map_err(|e| e.to_string())?;

            let app_handle = handle.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    let _ = app_handle.emit("reader-webview-state", false);
                }
            });

            handle
                .emit("reader-webview-state", true)
                .map_err(|e| e.to_string())
        })();

        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
async fn close_reader_webview(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        let result = if let Some(window) = handle.get_webview_window("reader-webview") {
            window.destroy().map_err(|e| e.to_string())
        } else {
            Ok(())
        };
        let _ = tx.send(result);
    }).map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

#[tauri::command]
async fn reader_webview_is_open(app: tauri::AppHandle) -> Result<bool, String> {
    let handle = app.clone();
    let (tx, rx) = mpsc::channel::<bool>();

    app.run_on_main_thread(move || {
        let _ = tx.send(handle.get_webview_window("reader-webview").is_some());
    }).map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())
}

fn books_data_dir() -> PathBuf {
    suwayomi_data_dir().join("books")
}

fn book_asset_content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("epub") => "application/epub+zip",
        _ => "application/octet-stream",
    }
}

fn book_asset_error(status: StatusCode, message: &str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Owned(message.as_bytes().to_vec()))
        .unwrap()
}

fn resolve_book_asset_path(request: &Request<Vec<u8>>) -> Result<PathBuf, Response<Cow<'static, [u8]>>> {
    let encoded_path = request.uri().path();
    if encoded_path.len() <= 1 {
        return Err(book_asset_error(StatusCode::BAD_REQUEST, "Missing book asset path."));
    }

    let decoded_path = percent_decode(&encoded_path.as_bytes()[1..])
        .decode_utf8_lossy()
        .to_string();
    if decoded_path.is_empty() {
        return Err(book_asset_error(StatusCode::BAD_REQUEST, "Missing book asset path."));
    }

    let candidate = PathBuf::from(decoded_path);
    let root = books_data_dir();

    let canonical_root = root
        .canonicalize()
        .map_err(|_| book_asset_error(StatusCode::INTERNAL_SERVER_ERROR, "Books storage root is unavailable."))?;
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|_| book_asset_error(StatusCode::NOT_FOUND, "Book asset was not found."))?;

    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(book_asset_error(StatusCode::FORBIDDEN, "Book asset is outside the allowed scope."));
    }

    Ok(canonical_candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_percent_encoded_windows_book_asset_paths() {
        let request = Request::builder()
            .uri("http://book.localhost/C%3A%5CUsers%5Cjhow-%5CAppData%5CRoaming%5Caethon%5Cbooks%5Ccovers%5Ccover.jpg")
            .body(Vec::new())
            .unwrap();

        let decoded_path = percent_decode(&request.uri().path().as_bytes()[1..])
            .decode_utf8_lossy()
            .to_string();

        assert_eq!(
            decoded_path,
            r"C:\Users\jhow-\AppData\Roaming\aethon\books\covers\cover.jpg"
        );
    }
}

fn serve_book_asset(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = match resolve_book_asset_path(&request) {
        Ok(path) => path,
        Err(response) => return response,
    };

    match fs::read(&path) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, book_asset_content_type(&path))
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(Cow::Owned(bytes))
            .unwrap(),
        Err(_) => book_asset_error(StatusCode::NOT_FOUND, "Book asset could not be read."),
    }
}

fn is_allowed_reader_navigation(reader_host: Option<&str>, next_url: &url::Url) -> bool {
    let Some(host) = next_url.host_str() else {
        return matches!(next_url.scheme(), "about" | "data" | "blob");
    };

    if let Some(reader_host) = reader_host {
        if host == reader_host {
            return true;
        }
    }

    let blocked = [
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "adnxs.com",
        "taboola.com",
        "outbrain.com",
        "exoclick.com",
        "popads.net",
        "propellerads.com",
        "adsterra.com",
        "clickadu.com",
        "hilltopads.net",
        "trafficjunky.net",
        "juicyads.com",
    ];

    !blocked.iter().any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(PathBuf::from(path)).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn copy_book_import(source_path: String, book_id: String) -> Result<String, String> {
    let source = PathBuf::from(source_path);
    if !source.exists() {
        return Err("Selected book file no longer exists.".to_string());
    }

    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "bin".to_string());

    let folder = match ext.as_str() {
        "epub" => "epubs",
        "pdf" => "pdfs",
        _ => "imports",
    };

    let dest_dir = books_data_dir().join(folder);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest_path = dest_dir.join(format!("{book_id}.{ext}"));
    std::fs::copy(&source, &dest_path).map_err(|e| e.to_string())?;
    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
fn write_book_cover(book_id: String, bytes_base64: String, ext: String) -> Result<String, String> {
    let dest_dir = books_data_dir().join("covers");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest_path = dest_dir.join(format!("{book_id}.{}", ext.trim_matches('.')));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|e| e.to_string())?;
    std::fs::write(&dest_path, bytes).map_err(|e| e.to_string())?;
    Ok(dest_path.to_string_lossy().to_string())
}

#[tauri::command]
fn remove_book_assets(asset_path: Option<String>, cover_path: Option<String>) -> Result<(), String> {
    for path in [asset_path, cover_path].into_iter().flatten() {
        let candidate = PathBuf::from(path);
        if !candidate.exists() {
            continue;
        }
        std::fs::remove_file(&candidate).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Update types ──────────────────────────────────────────────────────────────

/// A single GitHub release returned to the frontend.
#[derive(Serialize, Clone)]
pub struct ReleaseInfo {
    pub tag_name:     String,
    pub name:         String,
    pub body:         String,
    pub published_at: String,
    pub html_url:     String,
}

/// Progress event emitted during download — matches what the frontend listens for.
#[derive(Clone, serde::Serialize)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct UpdateProgress {
    downloaded: u64,
    total:      Option<u64>,
}

/// Strip the \\?\ extended-length path prefix that Windows adds to long paths.
/// Java and many other tools do not accept this prefix and will fail silently.
fn strip_unc(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

fn resolve_downloads_path(downloads_path: &str) -> PathBuf {
    if !downloads_path.trim().is_empty() {
        return PathBuf::from(downloads_path);
    }
    // Mirror Suwayomi-Server's own default: <data_dir>/Tachidesk/downloads
    // Windows: %LOCALAPPDATA%\Tachidesk\downloads
    // macOS:   ~/Library/Application Support/Tachidesk/downloads
    // Linux:   $XDG_DATA_HOME/Tachidesk/downloads  (~/.local/share/Tachidesk/downloads)
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::data_dir().unwrap_or_else(|| PathBuf::from("/")));
    base.join("Tachidesk").join("downloads")
}

#[tauri::command]
fn get_storage_info(downloads_path: String) -> Result<StorageInfo, String> {
    let path = resolve_downloads_path(&downloads_path);

    let manga_bytes = if path.exists() {
        WalkDir::new(&path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter_map(|e| e.metadata().ok())
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .sum()
    } else {
        0
    };

    let stat_path = if path.exists() {
        path.clone()
    } else {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
    };

    let disks = Disks::new_with_refreshed_list();
    let disk = disks
        .iter()
        .filter(|d| stat_path.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .ok_or_else(|| "Could not find disk for path".to_string())?;

    Ok(StorageInfo {
        manga_bytes,
        total_bytes: disk.total_space(),
        free_bytes:  disk.available_space(),
        path: path.to_string_lossy().into_owned(),
    })
}

/// Returns the resolved default downloads path for the current platform.
/// This mirrors resolve_downloads_path("") so the frontend can display it.
#[tauri::command]
fn get_default_downloads_path() -> String {
    resolve_downloads_path("").to_string_lossy().into_owned()
}

/// Returns true if the given path exists and is a directory.
#[tauri::command]
fn check_path_exists(path: String) -> bool {
    std::path::Path::new(path.trim()).is_dir()
}

/// Creates a directory and all missing parent directories.
#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(path.trim()).map_err(|e| e.to_string())
}

fn acquire_server_lock(lock_path: &Path, data_dir: &Path) -> std::io::Result<bool> {
    match std::fs::OpenOptions::new().write(true).create_new(true).open(lock_path) {
        Ok(mut file) => {
            let _ = writeln!(file, "pid={}", std::process::id());
            let _ = writeln!(file, "rootDir={}", data_dir.to_string_lossy());
            let _ = writeln!(file, "timestamp={:?}", std::time::SystemTime::now());
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(err),
    }
}

fn read_server_lock_pid(lock_path: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(lock_path).ok()?;
    text.lines()
        .find_map(|line| line.trim().strip_prefix("pid=")?.trim().parse::<u32>().ok())
}

fn process_is_alive(pid: u32) -> bool {
    let system = System::new_all();
    system.process(Pid::from_u32(pid)).is_some()
}

fn java_process_uses_rootdir(process: &sysinfo::Process, rootdir_flag: &str) -> bool {
    let name = process.name().to_string_lossy().to_ascii_lowercase();
    if !name.contains("java") {
        return false;
    }

    process.cmd().iter().any(|arg| arg.to_string_lossy().contains(rootdir_flag))
}

fn existing_server_for_profile(data_dir: &Path) -> bool {
    let rootdir_flag = format!(
        "-Dsuwayomi.tachidesk.config.server.rootDir={}",
        data_dir.to_string_lossy()
    );
    let system = System::new_all();
    system
        .processes()
        .values()
        .any(|process| java_process_uses_rootdir(process, &rootdir_flag))
}

#[tauri::command]
async fn download_server_file_to_downloads(
    url: String,
    filename: Option<String>,
    auth_header: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_http::reqwest;

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client.get(url.trim());
    if let Some(header) = auth_header.as_ref().filter(|h| !h.trim().is_empty()) {
        request = request.header("Authorization", header.trim());
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Download failed with HTTP {}", response.status()));
    }

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let downloads_dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not resolve Downloads directory".to_string())?;

    std::fs::create_dir_all(&downloads_dir).map_err(|e| e.to_string())?;

    let raw_name = filename
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("aethon-backup.tachibk");
    let safe_name: String = raw_name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect();

    let target = downloads_dir.join(safe_name);
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;

    Ok(target.to_string_lossy().into_owned())
}

/// Moves all content from `src` into `dst`, then removes `src`.
/// Emits `migrate_progress` events: `{ done, total, current }`.
/// Only deletes the source tree after every file is confirmed copied.
#[tauri::command]
async fn migrate_downloads(
    app: tauri::AppHandle,
    src: String,
    dst: String,
) -> Result<(), String> {
    use tauri::Emitter;
    use std::fs;

    let src_path = std::path::PathBuf::from(src.trim());
    let dst_path = std::path::PathBuf::from(dst.trim());

    if !src_path.is_dir() {
        return Ok(()); // nothing to migrate
    }

    // Count files first so the frontend can show accurate progress
    let total: u64 = WalkDir::new(&src_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .count() as u64;

    let _ = app.emit("migrate_progress", serde_json::json!({
        "done": 0u64, "total": total, "current": ""
    }));

    let mut done: u64 = 0;

    for entry in WalkDir::new(&src_path).into_iter().filter_map(|e| e.ok()) {
        let rel    = entry.path().strip_prefix(&src_path).map_err(|e| e.to_string())?;
        let target = dst_path.join(rel);

        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
            done += 1;
            let _ = app.emit("migrate_progress", serde_json::json!({
                "done": done,
                "total": total,
                "current": rel.to_string_lossy()
            }));
        }
    }

    // Only remove source after all files are confirmed copied
    fs::remove_dir_all(&src_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns the OS/monitor DPI scale factor for the window's current monitor.
/// This is the real hardware scale — 1.0 on standard displays, 2.0 on HiDPI/4K,
/// 1.25–1.5 on Windows displays with OS-level scaling applied.
/// The frontend multiplies this by the user's uiZoom preference to get the
/// final effective zoom applied to document.documentElement.
#[tauri::command]
fn get_platform_ui_scale(window: tauri::Window) -> f64 {
    window.scale_factor().unwrap_or(1.0)
}

fn reconciliation_overlay_path() -> Result<PathBuf, String> {
    let dir = suwayomi_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("backup-reconciliation-overlay.json"))
}

#[tauri::command]
fn read_reconciliation_overlay() -> Result<Option<String>, String> {
    let path = reconciliation_overlay_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(Some(text))
}

#[tauri::command]
fn write_reconciliation_overlay(contents: String) -> Result<(), String> {
    let path = reconciliation_overlay_path()?;
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

fn kill_tachidesk(app: &tauri::AppHandle) {
    let running = {
        let state = app.state::<ServerState>();
        let mut guard = state.0.lock().unwrap();
        guard.take()
    };

    if let Some(running) = running {
        let _ = running.child.kill();
        let _ = std::fs::remove_file(running.lock_path);
        return;
    }
}


const DEFAULT_SERVER_CONF: &str = r#"server.ip = "127.0.0.1"
server.port = 4567
server.webUIEnabled = false
server.initialOpenInBrowserEnabled = false
server.systemTrayEnabled = false
server.webUIInterface = "browser"
server.webUIFlavor = "WebUI"
server.webUIChannel = "stable"
server.electronPath = ""
server.debugLogsEnabled = false
server.downloadAsCbz = true
server.autoDownloadNewChapters = false
server.globalUpdateInterval = 12
server.maxSourcesInParallel = 6
server.extensionRepos = []
"#;

fn seed_server_conf(data_dir: &PathBuf) {
    let conf_path = data_dir.join("server.conf");

    if !conf_path.exists() {
        if let Err(e) = std::fs::create_dir_all(data_dir) {
            eprintln!("Could not create Suwayomi data dir: {e}");
            return;
        }
        if let Err(e) = std::fs::write(&conf_path, DEFAULT_SERVER_CONF) {
            eprintln!("Could not write server.conf: {e}");
        }
        return;
    }

    let Ok(contents) = std::fs::read_to_string(&conf_path) else { return };

    let patched = patch_conf_key(
        patch_conf_key(
            patch_conf_key(contents, "server.webUIEnabled", "false"),
            "server.initialOpenInBrowserEnabled", "false",
        ),
        "server.systemTrayEnabled", "false",
    );

    let _ = std::fs::write(&conf_path, patched);
}

fn patch_conf_key(text: String, key: &str, value: &str) -> String {
    let replacement = format!("{key} = {value}");
    let lines: Vec<&str> = text.lines().collect();

    if let Some(pos) = lines.iter().position(|l| l.trim_start().starts_with(key)) {
        let mut out = lines
            .iter()
            .enumerate()
            .map(|(i, l)| if i == pos { replacement.as_str() } else { l })
            .collect::<Vec<_>>()
            .join("\n");
        out.push('\n');
        return out;
    }

    let mut out = text;
    if !out.ends_with('\n') { out.push('\n'); }
    out.push_str(&replacement);
    out.push('\n');
    out
}

fn suwayomi_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
            .join("aethon")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("~")))
            .join("aethon")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::data_dir().unwrap_or_else(|| PathBuf::from("/tmp")));
        base.join("aethon")
    }
}

fn legacy_suwayomi_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "windows")]
    {
        dirs.push(
            dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
                .join("moku\\tachidesk"),
        );

        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Tachidesk"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        dirs.push(
            dirs::data_dir()
                .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from("~")))
                .join("dev.moku.app/tachidesk"),
        );
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::data_dir().unwrap_or_else(|| PathBuf::from("/tmp")));
        dirs.push(base.join("moku/tachidesk"));
    }

    dirs
}

fn ensure_suwayomi_data_dir() -> PathBuf {
    let canonical = suwayomi_data_dir();

    if canonical.exists() {
        return canonical;
    }

    for legacy in legacy_suwayomi_data_dirs() {
        if !legacy.exists() || legacy == canonical {
            continue;
        }

        if let Some(parent) = canonical.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        if std::fs::rename(&legacy, &canonical).is_ok() {
            return canonical;
        }
    }

    canonical
}

struct ServerInvocation {
    bin:         String,
    args:        Vec<String>,
    working_dir: Option<PathBuf>,
}

/// Locate the `java` / `java.exe` binary inside a bundled JRE directory.
///
/// Expected layout (Windows and Linux):
///   <bundle_dir>/jre/bin/java[.exe]
///
/// On Windows `strip_unc` is applied so Java doesn't choke on `\\?\` prefixes.
#[cfg(not(target_os = "macos"))]
fn find_java_in_bundle(bundle_dir: &PathBuf, log: &mut Option<std::fs::File>) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let java = strip_unc(bundle_dir.join("jre").join("bin").join("java.exe"));

    #[cfg(not(target_os = "windows"))]
    let java = bundle_dir.join("jre").join("bin").join("java");

    do_log(log, &format!("[find_java] checking path: {:?}", java));
    do_log(log, &format!("[find_java] exists: {}", java.exists()));

    if java.exists() { Some(java) } else { None }
}

fn do_log(log: &mut Option<std::fs::File>, msg: &str) {
    eprintln!("{}", msg);
    if let Some(f) = log {
        let _ = writeln!(f, "{}", msg);
    }
}

fn resolve_server_binary(
    binary: &str,
    app: &tauri::AppHandle,
    log: &mut Option<std::fs::File>,
) -> Result<ServerInvocation, SpawnError> {
    do_log(log, &format!("[resolve] binary arg = {:?}", binary));

    // ── 1. User-specified binary path ─────────────────────────────────────────
    // Primary: honour the path as-is (doc-2 behaviour — trust the user).
    // Fallback: if the path doesn't exist after stripping UNC, log a warning
    // and continue so the bundled detection still has a chance.
    if !binary.trim().is_empty() {
        let path = strip_unc(PathBuf::from(binary.trim()));
        do_log(log, &format!("[resolve] user path: {:?} exists={}", path, path.exists()));
        if path.exists() {
            return Ok(ServerInvocation {
                bin:         path.to_string_lossy().into_owned(),
                args:        vec![],
                working_dir: path.parent().map(|p| p.to_path_buf()),
            });
        }
        // Fallback: path was set but file is missing — warn and keep trying.
        do_log(log, "[resolve] WARNING: user-supplied path not found, falling through to bundled detection");
    }

    // Resolve and UNC-strip resource_dir once; used by all non-macOS branches.
    #[cfg(not(target_os = "macos"))]
    let resource_dir = {
        let raw = app.path().resource_dir().unwrap_or_default();
        let stripped = strip_unc(raw);
        do_log(log, &format!("[resolve] resource_dir (stripped) = {:?}", stripped));
        stripped
    };

    // ── 2. Bundled JRE + JAR (Windows / Linux — specific layout) ─────────────
    // Primary path from doc-2: binaries/suwayomi-bundle/bin/Suwayomi-Server.jar
    #[cfg(not(target_os = "macos"))]
    {
        let bundle_dir = resource_dir.join("binaries").join("suwayomi-bundle");
        let jar        = bundle_dir.join("bin").join("Suwayomi-Server.jar");

        do_log(log, &format!("[resolve] bundle_dir = {:?}", bundle_dir));
        do_log(log, &format!("[resolve] bundle_dir exists: {}", bundle_dir.exists()));
        do_log(log, &format!("[resolve] jar = {:?}", jar));
        do_log(log, &format!("[resolve] jar exists: {}", jar.exists()));

        match find_java_in_bundle(&bundle_dir, log) {
            Some(java) => {
                do_log(log, &format!("[resolve] java found: {:?}", java));
                if jar.exists() {
                    do_log(log, "[resolve] both java and jar found — using bundled JRE");
                    return Ok(ServerInvocation {
                        bin:  java.to_string_lossy().into_owned(),
                        args: vec!["-jar".to_string(), jar.to_string_lossy().into_owned()],
                        working_dir: Some(bundle_dir),
                    });
                }
                do_log(log, "[resolve] java found but jar MISSING — falling through");
            }
            None => {
                do_log(log, "[resolve] java NOT found in bundle — falling through");
            }
        }
    }

    // ── 2b. Bundled launcher scripts / native sidecars (Windows / Linux) ──────
    // Fallback for older bundle layouts that ship a wrapper script instead of a
    // bare JRE + JAR.  Also scans for any *.jar in resource_dir as a last resort.
    #[cfg(not(target_os = "macos"))]
    {
        // Named launcher scripts.
        let script_candidates = ["suwayomi-launcher", "suwayomi-launcher.sh", "tachidesk-server"];
        for name in &script_candidates {
            let p = resource_dir.join(name);
            do_log(log, &format!("[resolve] sidecar candidate: {:?} exists={}", p, p.exists()));
            if p.exists() {
                do_log(log, &format!("[resolve] using sidecar: {:?}", p));
                return Ok(ServerInvocation {
                    bin:         p.to_string_lossy().into_owned(),
                    args:        vec![],
                    working_dir: Some(resource_dir.clone()),
                });
            }
        }

        // Generic JRE at resource_dir root + any *.jar alongside it.
        do_log(log, "[resolve] no named sidecar found, trying generic JRE + any jar in resource_dir");
        if let Some(java) = find_java_in_bundle(&resource_dir, log) {
            let jar = std::fs::read_dir(&resource_dir)
                .ok()
                .and_then(|mut rd| {
                    rd.find(|e| {
                        e.as_ref()
                            .map(|e| e.file_name().to_string_lossy().ends_with(".jar"))
                            .unwrap_or(false)
                    })
                    .and_then(|e| e.ok())
                    .map(|e| e.path())
                });

            do_log(log, &format!("[resolve] generic jar candidate: {:?}", jar));

            if let Some(jar_path) = jar {
                do_log(log, &format!("[resolve] using generic JRE java={:?} jar={:?}", java, jar_path));
                return Ok(ServerInvocation {
                    bin:  java.to_string_lossy().into_owned(),
                    args: vec!["-jar".to_string(), jar_path.to_string_lossy().into_owned()],
                    working_dir: Some(resource_dir),
                });
            }
            do_log(log, "[resolve] generic JRE found but no .jar — falling through");
        }
    }

    // ── 3. macOS app bundle — MacOS/ then Resources/ ──────────────────────────
    #[cfg(target_os = "macos")]
    {
        let resource_dir = app.path().resource_dir().unwrap_or_default();
        let macos_dir    = resource_dir
            .parent()
            .map(|p| p.join("MacOS"))
            .unwrap_or_default();

        do_log(log, &format!("[resolve] macOS macos_dir = {:?}", macos_dir));

        // Tauri strips the target triple when installing externalBin sidecars into
        // Contents/MacOS/, so the binary is "suwayomi-server" at runtime.
        // Triple-suffixed names are kept as a belt-and-suspenders fallback for
        // dev / flat layouts.
        let candidates = [
            "suwayomi-server",
            "suwayomi-server-aarch64-apple-darwin",
            "suwayomi-server-x86_64-apple-darwin",
            "suwayomi-launcher",
            "suwayomi-launcher.sh",
            "tachidesk-server",
        ];

        for search_dir in &[&macos_dir, &resource_dir] {
            for name in &candidates {
                let p = search_dir.join(name);
                do_log(log, &format!("[resolve] macOS candidate: {:?} exists={}", p, p.exists()));
                if p.exists() {
                    do_log(log, &format!("[resolve] using macOS sidecar: {:?}", p));
                    return Ok(ServerInvocation {
                        bin:         p.to_string_lossy().into_owned(),
                        args:        vec![],
                        working_dir: None,
                    });
                }
            }
        }
    }

    // ── 4. PATH fallback ──────────────────────────────────────────────────────
    // Use `where` on Windows, `which` everywhere else.
    do_log(log, "[resolve] trying PATH fallback");
    for name in &["suwayomi-server", "tachidesk-server"] {
        #[cfg(target_os = "windows")]
        let found = std::process::Command::new("where")
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        #[cfg(not(target_os = "windows"))]
        let found = std::process::Command::new("which")
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        do_log(log, &format!("[resolve] PATH check {:?}: found={}", name, found));

        if found {
            do_log(log, &format!("[resolve] using PATH binary: {}", name));
            return Ok(ServerInvocation {
                bin:         name.to_string(),
                args:        vec![],
                working_dir: None,
            });
        }
    }

    do_log(log, "[resolve] FAILED — no binary found anywhere");
    Err(SpawnError::NotConfigured(
        "Server binary not found. Install Suwayomi-Server or set the path in Settings.".to_string(),
    ))
}

#[tauri::command]
fn spawn_server(binary: String, app: tauri::AppHandle) -> Result<(), SpawnError> {
    {
        let state = app.state::<ServerState>();
        if state.0.lock().unwrap().is_some() {
            return Ok(());
        }
    }

    let data_dir = ensure_suwayomi_data_dir();
    let lock_path = data_dir.join("server.lock");

    let log_path = data_dir.join("aethon-spawn.log");
    let _ = std::fs::create_dir_all(&data_dir);
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();

    do_log(&mut log, "");
    do_log(&mut log, "========================================");
    do_log(&mut log, &format!("[spawn_server] called at {:?}", std::time::SystemTime::now()));
    do_log(&mut log, &format!("[spawn_server] binary arg = {:?}", binary));
    do_log(&mut log, &format!("[spawn_server] data_dir = {:?}", data_dir));
    do_log(&mut log, &format!("[spawn_server] log file = {:?}", log_path));
    do_log(&mut log, &format!("[spawn_server] APPDATA = {:?}", std::env::var("APPDATA")));
    do_log(&mut log, &format!("[spawn_server] LOCALAPPDATA = {:?}", std::env::var("LOCALAPPDATA")));
    do_log(&mut log, &format!("[spawn_server] current_dir = {:?}", std::env::current_dir()));

    let existing_server = existing_server_for_profile(&data_dir);
    let lock_owner_pid = read_server_lock_pid(&lock_path);

    if lock_path.exists() {
        match lock_owner_pid {
            Some(pid) if process_is_alive(pid) => {
                do_log(&mut log, &format!(
                    "[spawn_server] lock denied: server.lock is owned by live Aethon pid {}",
                    pid
                ));
                return Ok(());
            }
            Some(pid) => {
                do_log(&mut log, &format!(
                    "[spawn_server] found stale server.lock from dead pid {}",
                    pid
                ));
            }
            None => {
                do_log(&mut log, "[spawn_server] found invalid or unreadable server.lock metadata");
            }
        }

        if existing_server {
            do_log(&mut log, "[spawn_server] spawn skipped because a Java/Suwayomi process already owns this profile");
            return Ok(());
        }

        let _ = std::fs::remove_file(&lock_path);
        do_log(&mut log, &format!("[spawn_server] removed stale lock {:?}", lock_path));
    } else if existing_server {
        do_log(&mut log, "[spawn_server] reusing existing server because a Java/Suwayomi process is already running for this profile");
        return Ok(());
    }

    match acquire_server_lock(&lock_path, &data_dir) {
        Ok(true) => {
            do_log(&mut log, &format!("[spawn_server] acquired lock {:?}", lock_path));
        }
        Ok(false) => {
            do_log(&mut log, "[spawn_server] lock denied during acquisition race; spawn skipped");
            return Ok(());
        }
        Err(err) => {
            do_log(&mut log, &format!("[spawn_server] lock FAILED: {}", err));
            return Err(SpawnError::SpawnFailed(err.to_string()));
        }
    }

    seed_server_conf(&data_dir);
    do_log(&mut log, "[spawn_server] server.conf seeded");

    let mut invocation = match resolve_server_binary(&binary, &app, &mut log) {
        Ok(i) => i,
        Err(e) => {
            let _ = std::fs::remove_file(&lock_path);
            do_log(&mut log, &format!("[spawn_server] resolve FAILED: {:?}", e));
            return Err(e);
        }
    };

    let bin_display = invocation.bin.clone();
    let rootdir_flag = format!(
        "-Dsuwayomi.tachidesk.config.server.rootDir={}",
        data_dir.to_string_lossy()
    );

    invocation.args.insert(0, rootdir_flag);

    let working_dir = invocation.working_dir
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    do_log(&mut log, &format!("[spawn_server] bin = {:?}", bin_display));
    do_log(&mut log, &format!("[spawn_server] args = {:?}", invocation.args));
    do_log(&mut log, &format!("[spawn_server] working_dir = {:?}", working_dir));

    let cmd = app.shell()
        .command(&invocation.bin)
        .env("JAVA_TOOL_OPTIONS", "-Djava.awt.headless=true")
        .args(&invocation.args)
        .current_dir(&working_dir);

    do_log(&mut log, "[spawn_server] calling cmd.spawn()...");

    match cmd.spawn() {
        Ok((_rx, child)) => {
            do_log(&mut log, &format!("[spawn_server] SUCCESS — spawned: {}", bin_display));
            *app.state::<ServerState>().0.lock().unwrap() = Some(RunningServer { child, lock_path });
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(&lock_path);
            do_log(&mut log, &format!("[spawn_server] SPAWN FAILED: {}", e));
            do_log(&mut log, &format!("[spawn_server] error kind: {:?}", e));
            Err(SpawnError::SpawnFailed(e.to_string()))
        }
    }
}

#[tauri::command]
fn kill_server(app: tauri::AppHandle) -> Result<(), String> {
    kill_tachidesk(&app);
    Ok(())
}

// ── Update commands ───────────────────────────────────────────────────────────

/// Fetch the list of all GitHub releases so the frontend can show a version picker.
/// Uses tauri-plugin-http so it goes through Tauri's permission system.
#[tauri::command]
async fn list_releases() -> Result<Vec<ReleaseInfo>, String> {
    use tauri_plugin_http::reqwest;

    let client = reqwest::Client::builder()
        .user_agent("Moku")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("https://api.github.com/repos/Youwes09/Moku/releases?per_page=30")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct GhRelease {
        tag_name:     String,
        name:         Option<String>,
        body:         Option<String>,
        published_at: Option<String>,
        html_url:     String,
    }

    let body = resp.text().await.map_err(|e| e.to_string())?;
    let releases: Vec<GhRelease> = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    Ok(releases
        .into_iter()
        .map(|r| ReleaseInfo {
            tag_name:     r.tag_name.clone(),
            name:         r.name.unwrap_or_else(|| r.tag_name.clone()),
            body:         r.body.unwrap_or_default(),
            published_at: r.published_at.unwrap_or_default(),
            html_url:     r.html_url,
        })
        .collect())
}

/// Download and install the latest update using tauri-plugin-updater.
/// Emits `update-progress` events with `{ downloaded, total }` while downloading.
/// On Windows the installer runs in passive (silent) mode; the frontend prompts restart.
/// On other platforms this command is a no-op — the frontend opens the GitHub page instead.
#[tauri::command]
#[allow(unused_variables)]
async fn download_and_install_update(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    return Err("Native install is Windows-only; open the GitHub release page instead.".into());

    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_updater::UpdaterExt;

        let updater = app.updater().map_err(|e| e.to_string())?;
        let update  = updater.check().await.map_err(|e| e.to_string())?;

        let Some(update) = update else {
            return Err("No update available from the updater endpoint.".into());
        };

        let app_clone = app.clone();
        update
            .download_and_install(
                move |downloaded, total| {
                    let _ = app_clone.emit("update-progress", UpdateProgress { downloaded: downloaded as u64, total });
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;

        Ok(())
    }
}

/// Restart the app after a successful update install.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    tauri::process::restart(&app.env());
}

fn parse_launch_target() -> LaunchTargetInfo {
    let mut server_url_override = None;
    let mut profile_label_override = None;

    for arg in std::env::args().skip(1) {
        if let Some(value) = arg.strip_prefix("--server-url=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                server_url_override = Some(trimmed.trim_end_matches('/').to_string());
            }
            continue;
        }

        if let Some(value) = arg.strip_prefix("--profile-label=") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                profile_label_override = Some(trimmed.to_uppercase());
            }
            continue;
        }

        match arg.as_str() {
            "--main" => {
                server_url_override = Some("http://127.0.0.1:4567".to_string());
                profile_label_override = Some("MAIN".to_string());
            }
            "--test" => {
                server_url_override = Some("http://127.0.0.1:4667".to_string());
                profile_label_override = Some("TEST".to_string());
            }
            _ => {}
        }
    }

    LaunchTargetInfo {
        server_url_override,
        profile_label_override,
    }
}

#[tauri::command]
fn get_launch_target(state: tauri::State<'_, LaunchTarget>) -> LaunchTargetInfo {
    state.0.clone()
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("book", |_ctx, request| serve_book_asset(request))
        .plugin(tauri_plugin_drpc::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(LaunchTarget(parse_launch_target()))
        .manage(ServerState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_launch_target,
            get_storage_info,
            get_default_downloads_path,
            check_path_exists,
            create_directory,
            download_server_file_to_downloads,
              migrate_downloads,
              read_reconciliation_overlay,
              write_reconciliation_overlay,
                open_reader_webview,
                close_reader_webview,
                reader_webview_is_open,
                read_file_base64,
                copy_book_import,
                write_book_cover,
                remove_book_assets,
                spawn_server,
              kill_server,
            get_platform_ui_scale,
            list_releases,
            download_and_install_update,
            restart_app,
        ])
        .setup(|_app| Ok(()))
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) && window.label() == "main" {
                kill_tachidesk(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running moku");
}
