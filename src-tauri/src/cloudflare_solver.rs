//! Built-in Cloudflare challenge solver speaking the FlareSolverr v1 protocol.
//!
//! Suwayomi only knows how to pass Cloudflare through a FlareSolverr endpoint. Instead of
//! downloading and running a separate Chromium, the desktop app solves the challenge in an
//! off-screen WebView2 window (same engine and user agent as the main window) and hands the
//! resulting cookies back. The endpoint listens on loopback only, on an ephemeral port, behind a
//! random path token, and the solver window gets no capability, so it can run no app command.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use tauri::{webview::PageLoadEvent, AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const WINDOW_LABEL: &str = "cloudflare-solver";
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const POLL_INTERVAL: Duration = Duration::from_millis(400);
const PROTOCOL_VERSION: &str = "3.4.6-epigraph";
/// Physical pixels between the leftmost monitor and the solver window; wider than the window.
const OFFSCREEN_GAP: i32 = 6_000;

/// How long a host is not retried after each kind of failed solve. Suwayomi asks for any
/// protected request (covers, feeds, library updates), so a host that keeps failing would
/// otherwise reopen the solver every few minutes. A block page does not clear by waiting.
const BLOCKED_COOLDOWN: Duration = Duration::from_secs(6 * 60 * 60);
const CANCELLED_COOLDOWN: Duration = Duration::from_secs(30 * 60);
const TIMEOUT_COOLDOWN: Duration = Duration::from_secs(10 * 60);
const _: () = assert!(BLOCKED_COOLDOWN.as_secs() > CANCELLED_COOLDOWN.as_secs());
const _: () = assert!(CANCELLED_COOLDOWN.as_secs() >= TIMEOUT_COOLDOWN.as_secs());
/// Title the page script sets on a Cloudflare block page, which no waiting can clear.
const BLOCKED_TITLE: &str = "epigraph:cloudflare-blocked";
/// Navigation target of the close button; the window never loads it.
const CANCEL_HOST: &str = "epigraph-solver.invalid";
/// The window is meant to stay off-screen, but if it ever shows up the user can close it, and a
/// block page ends the solve at once instead of waiting for the timeout.
const PAGE_SCRIPT: &str = r#"(() => {
  const check = () => {
    const headline = document.querySelector('[data-translate="block_headline"]');
    const h1 = document.querySelector("h1");
    if (headline || /you have been blocked/i.test(h1 ? h1.textContent || "" : "")) {
      document.title = "epigraph:cloudflare-blocked";
    }
  };
  const addClose = () => {
    if (!document.body || document.getElementById("epigraph-solver-close")) return;
    const button = document.createElement("button");
    button.id = "epigraph-solver-close";
    button.type = "button";
    button.textContent = "✕";
    button.title = "Close";
    button.setAttribute("aria-label", "Close");
    button.style.cssText = "position:fixed;top:8px;right:8px;z-index:2147483647;width:32px;height:32px;"
      + "border:0;border-radius:16px;background:#202124;color:#fff;font:16px/32px sans-serif;cursor:pointer;";
    button.addEventListener("click", () => { location.href = "https://epigraph-solver.invalid/cancel"; });
    document.body.appendChild(button);
  };
  document.addEventListener("DOMContentLoaded", () => { check(); addClose(); });
  window.addEventListener("load", () => { check(); addClose(); });
})();"#;

static ENDPOINT: OnceLock<String> = OnceLock::new();
static USER_AGENT: Mutex<Option<String>> = Mutex::new(None);
/// Hosts the solver gave up on, with the moment they may be tried again.
static GIVEN_UP_HOSTS: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());

struct Solver {
    app: AppHandle,
    token: String,
    gate: tokio::sync::Mutex<()>,
}

/// Starts the endpoint once per process; later calls are no-ops.
pub fn start(app: &AppHandle) {
    if ENDPOINT.get().is_some() {
        return;
    }
    let solver = Arc::new(Solver {
        app: app.clone(),
        token: uuid::Uuid::new_v4().simple().to_string(),
        gate: tokio::sync::Mutex::new(()),
    });
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("[cloudflare-solver] bind failed: {error}");
                return;
            }
        };
        let Ok(address) = listener.local_addr() else { return };
        let endpoint = format!("http://127.0.0.1:{}/epigraph-cf-{}", address.port(), solver.token);
        let router = Router::new()
            .route("/:token/v1", post(handle))
            .with_state(solver);
        if ENDPOINT.set(endpoint).is_err() {
            return;
        }
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("[cloudflare-solver] stopped: {error}");
        }
    });
}

/// Endpoint for Suwayomi's `flareSolverrUrl` (Suwayomi appends `/v1`). The main window passes its
/// own user agent, which the solver window shares and Suwayomi must reuse with the cookies.
#[tauri::command]
pub async fn builtin_cloudflare_solver_url(user_agent: String) -> Result<Option<String>, String> {
    let user_agent = user_agent.trim();
    if !user_agent.is_empty() && user_agent.len() <= 512 && user_agent.is_ascii() {
        *USER_AGENT.lock().map_err(|e| e.to_string())? = Some(user_agent.to_string());
    }
    for _ in 0..20 {
        if let Some(endpoint) = ENDPOINT.get() {
            return Ok(Some(endpoint.clone()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(None)
}

async fn handle(
    State(solver): State<Arc<Solver>>,
    Path(token): Path<String>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if token.strip_prefix("epigraph-cf-") != Some(solver.token.as_str()) {
        return (StatusCode::NOT_FOUND, Json(json!({ "status": "error", "message": "not found" })));
    }
    let started = epoch_ms();
    let cmd = body.get("cmd").and_then(Value::as_str).unwrap_or_default();
    let result = match cmd {
        "sessions.list" => Ok(json!({ "sessions": [] })),
        "sessions.create" => Ok(json!({ "session": body.get("session").cloned().unwrap_or(Value::Null) })),
        "sessions.destroy" => Ok(json!({})),
        "request.get" | "request.post" => {
            let timeout = body
                .get("maxTimeout")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_TIMEOUT_MS)
                .clamp(5_000, MAX_TIMEOUT_MS);
            match body.get("url").and_then(Value::as_str) {
                Some(url) => solver.solve(url, Duration::from_millis(timeout)).await.map(|solution| json!({ "solution": solution })),
                None => Err("Request parameter 'url' is mandatory".to_string()),
            }
        }
        other => Err(format!("Request parameter 'cmd' = '{other}' is invalid.")),
    };
    let (status, mut payload, message) = match result {
        Ok(payload) => (StatusCode::OK, payload, "Challenge solved!".to_string()),
        Err(message) => (StatusCode::INTERNAL_SERVER_ERROR, json!({}), format!("Error: {message}")),
    };
    payload["status"] = json!(if status == StatusCode::OK { "ok" } else { "error" });
    payload["message"] = json!(message);
    payload["startTimestamp"] = json!(started);
    payload["endTimestamp"] = json!(epoch_ms());
    payload["version"] = json!(PROTOCOL_VERSION);
    (status, Json(payload))
}

impl Solver {
    async fn solve(&self, raw_url: &str, timeout: Duration) -> Result<Value, String> {
        let url = url::Url::parse(raw_url).map_err(|e| e.to_string())?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("only http(s) URLs can be solved".into());
        }
        let user_agent = USER_AGENT
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or("the main window has not reported its user agent yet")?;
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        if recently_given_up(&host) {
            return Err(format!("{host} blocked the solver recently"));
        }
        let _serial = self.gate.lock().await;
        // A queued request for the same host may have waited behind the one that gave up.
        if recently_given_up(&host) {
            return Err(format!("{host} blocked the solver recently"));
        }

        let loaded = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let title = Arc::new(Mutex::new(String::new()));
        self.open_window(url.clone(), loaded.clone(), cancelled.clone(), title.clone()).await?;
        // The cookie store is shared with earlier solves; a clearance that is already present
        // predates this request and only counts once the page itself proves it valid.
        let before = match self.cookies(&url).await {
            Ok(cookies) => cookies.into_iter().find(|c| c.name == "cf_clearance").map(|c| c.value),
            Err(error) => {
                self.close_window();
                return Err(error);
            }
        };

        let deadline = Instant::now() + timeout;
        let mut loaded_since: Option<Instant> = None;
        let outcome = loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            if cancelled.load(Ordering::Acquire) {
                give_up(&host, CANCELLED_COOLDOWN);
                break Err("the user closed the Cloudflare window".to_string());
            }
            if title.lock().map(|t| t.as_str() == BLOCKED_TITLE).unwrap_or(false) {
                give_up(&host, BLOCKED_COOLDOWN);
                break Err(format!("Cloudflare blocked access to {host}"));
            }
            let cookies = match self.cookies(&url).await {
                Ok(cookies) => cookies,
                Err(error) => break Err(error),
            };
            let clearance = cookies.iter().find(|c| c.name == "cf_clearance").map(|c| c.value.clone());
            let fresh_clearance = clearance.is_some() && clearance != before;
            let current_title = title.lock().map(|t| t.trim().to_string()).unwrap_or_default();
            let page_ready = loaded.load(Ordering::Acquire) && !is_challenge_title(&current_title);
            loaded_since = if page_ready { loaded_since.or(Some(Instant::now())) } else { None };
            // A WebView2 that already holds a valid clearance loads the page with no new cookie.
            // Without a title yet, wait longer so a challenge page has time to name itself.
            let settle = if current_title.is_empty() { 1_500 } else { 800 };
            let settled = loaded_since.is_some_and(|since| since.elapsed() >= Duration::from_millis(settle));
            if fresh_clearance || settled {
                if fresh_clearance {
                    // Let the redirect after the challenge finish writing its cookies.
                    tokio::time::sleep(Duration::from_millis(600)).await;
                }
                break self.cookies(&url).await;
            }
            if Instant::now() >= deadline {
                give_up(&host, TIMEOUT_COOLDOWN);
                break Err(format!("Cloudflare challenge was not solved within {}s", timeout.as_secs()));
            }
        };
        self.close_window();
        // Host only: the path and query can carry tokens.
        match &outcome {
            Ok(_) => eprintln!("[cloudflare-solver] {host}: solved"),
            Err(message) => eprintln!("[cloudflare-solver] {host}: {message}"),
        }
        Ok(solution(&url, &outcome?, &user_agent))
    }

    async fn open_window(
        &self,
        url: url::Url,
        loaded: Arc<AtomicBool>,
        cancelled: Arc<AtomicBool>,
        title: Arc<Mutex<String>>,
    ) -> Result<(), String> {
        let app = self.app.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.app
            .run_on_main_thread(move || {
                if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
                    let _ = existing.destroy();
                }
                // Off-screen rather than hidden: WebView2 throttles invisible windows, which can
                // stall the challenge script. The window is built hidden and moved before it is
                // shown, because a starting position outside every monitor is ignored and the
                // window would open in the default place on the primary monitor.
                let result = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(url))
                    .title("Epigraph")
                    .visible(false)
                    .inner_size(800.0, 600.0)
                    .decorations(false)
                    .skip_taskbar(true)
                    .focused(false)
                    .focusable(false)
                    .initialization_script(PAGE_SCRIPT)
                    .on_navigation(move |next| {
                        if next.host_str() == Some(CANCEL_HOST) {
                            cancelled.store(true, Ordering::Release);
                            return false;
                        }
                        true
                    })
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .on_page_load(move |_, payload| {
                        loaded.store(matches!(payload.event(), PageLoadEvent::Finished), Ordering::Release);
                    })
                    .on_document_title_changed(move |_, next| {
                        if let Ok(mut current) = title.lock() {
                            *current = next;
                        }
                    })
                    .build()
                    .and_then(|window| {
                        window.set_position(offscreen_position(&window))?;
                        window.show()
                    })
                    .map_err(|e| e.to_string());
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }

    fn close_window(&self) {
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                let _ = window.destroy();
            }
        });
    }

    /// Reads the cookies WebView2 would send to `url`, HttpOnly `cf_clearance` included. Tauri's
    /// own cookie getter pumps a nested message loop on the UI thread and can lose its reply
    /// (panicking the caller), so the WebView2 request completes asynchronously instead.
    async fn cookies(&self, url: &url::Url) -> Result<Vec<SolverCookie>, String> {
        let window = self.app.get_webview_window(WINDOW_LABEL).ok_or("the solver window closed")?;
        let (reply, response) = tokio::sync::oneshot::channel();
        let uri = url.to_string();
        window
            .with_webview(move |webview| {
                #[cfg(windows)]
                webview2_cookies::request(webview.controller(), &uri, reply);
                #[cfg(not(windows))]
                {
                    let _ = (webview, uri);
                    let _ = reply.send(Err("cookie access is only implemented for WebView2".into()));
                }
            })
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(10), response)
            .await
            .map_err(|_| "reading the solver cookies timed out".to_string())?
            .map_err(|_| "reading the solver cookies failed".to_string())?
    }
}

#[derive(Debug, Clone)]
struct SolverCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    /// Unix seconds; `None` for session cookies.
    expires: Option<f64>,
    http_only: bool,
    secure: bool,
    same_site: &'static str,
}

#[cfg(windows)]
mod webview2_cookies {
    use super::SolverCookie;
    use webview2_com::{take_pwstr, GetCookiesCompletedHandler, Microsoft::Web::WebView2::Win32::*};
    use windows::core::{Interface, BOOL, HSTRING, PCWSTR, PWSTR};

    type Reply = tokio::sync::oneshot::Sender<Result<Vec<SolverCookie>, String>>;

    /// Runs on the UI thread. The completion handler owns `reply`; if the request cannot start,
    /// the handler is dropped with it and the waiting side sees the failure.
    pub(super) fn request(controller: ICoreWebView2Controller, uri: &str, reply: Reply) {
        let handler = GetCookiesCompletedHandler::create(Box::new(move |status, list| {
            let result = status.map_err(|e| e.to_string()).and_then(|()| unsafe { read_list(list) });
            let _ = reply.send(result);
            Ok(())
        }));
        let uri = HSTRING::from(uri);
        let _ = (|| unsafe {
            let webview = controller.CoreWebView2()?.cast::<ICoreWebView2_2>()?;
            webview.CookieManager()?.GetCookies(PCWSTR::from_raw(uri.as_ptr()), &handler)
        })();
    }

    unsafe fn read_list(list: Option<ICoreWebView2CookieList>) -> Result<Vec<SolverCookie>, String> {
        let Some(list) = list else { return Ok(Vec::new()) };
        let mut count = 0;
        list.Count(&mut count).map_err(|e| e.to_string())?;
        let mut cookies = Vec::with_capacity(count as usize);
        for index in 0..count {
            if let Ok(cookie) = list.GetValueAtIndex(index).and_then(|cookie| convert(&cookie)) {
                cookies.push(cookie);
            }
        }
        Ok(cookies)
    }

    unsafe fn text(read: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>) -> windows::core::Result<String> {
        let mut value = PWSTR::null();
        read(&mut value)?;
        Ok(take_pwstr(value))
    }

    unsafe fn convert(cookie: &ICoreWebView2Cookie) -> windows::core::Result<SolverCookie> {
        let name = text(|out| cookie.Name(out))?;
        let value = text(|out| cookie.Value(out))?;
        let domain = text(|out| cookie.Domain(out))?;
        let path = text(|out| cookie.Path(out))?;
        let mut http_only = BOOL::default();
        cookie.IsHttpOnly(&mut http_only)?;
        let mut secure = BOOL::default();
        cookie.IsSecure(&mut secure)?;
        let mut session = BOOL::default();
        cookie.IsSession(&mut session)?;
        let mut expires = -1.0;
        cookie.Expires(&mut expires)?;
        let mut same_site = COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX;
        cookie.SameSite(&mut same_site)?;
        Ok(SolverCookie {
            name,
            value,
            domain,
            path,
            expires: (!session.as_bool() && expires >= 0.0).then_some(expires),
            http_only: http_only.as_bool(),
            secure: secure.as_bool(),
            same_site: match same_site {
                COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT => "Strict",
                COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE => "None",
                _ => "Lax",
            },
        })
    }
}

fn solution(url: &url::Url, cookies: &[SolverCookie], user_agent: &str) -> Value {
    let cookies: Vec<Value> = cookies
        .iter()
        .map(|cookie| {
            json!({
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path,
                "expires": cookie.expires.unwrap_or(-1.0),
                "size": cookie.name.len() + cookie.value.len(),
                "httpOnly": cookie.http_only,
                "secure": cookie.secure,
                "session": cookie.expires.is_none(),
                "sameSite": cookie.same_site,
            })
        })
        .collect();
    json!({
        "url": url.as_str(),
        "status": 200,
        "headers": {},
        "response": "",
        "cookies": cookies,
        "userAgent": user_agent,
    })
}

/// A spot left of every monitor, far enough that no part of the window or its shadow shows.
fn offscreen_position(window: &WebviewWindow) -> PhysicalPosition<i32> {
    let lefts = window.available_monitors().unwrap_or_default().iter().map(|m| m.position().x).collect::<Vec<_>>();
    PhysicalPosition::new(offscreen_x(&lefts), 0)
}

fn offscreen_x(monitor_lefts: &[i32]) -> i32 {
    monitor_lefts.iter().copied().min().unwrap_or(0).min(0) - OFFSCREEN_GAP
}

fn recently_given_up(host: &str) -> bool {
    let Ok(mut hosts) = GIVEN_UP_HOSTS.lock() else { return false };
    let now = Instant::now();
    hosts.retain(|(_, retry_at)| *retry_at > now);
    hosts.iter().any(|(given_up, _)| given_up == host)
}

fn give_up(host: &str, cooldown: Duration) {
    if host.is_empty() {
        return;
    }
    if let Ok(mut hosts) = GIVEN_UP_HOSTS.lock() {
        let now = Instant::now();
        hosts.retain(|(given_up, retry_at)| given_up != host && *retry_at > now);
        hosts.push((host.to_string(), now + cooldown));
    }
}

/// Cloudflare localizes the interstitial title to the WebView2 UI language.
fn is_challenge_title(title: &str) -> bool {
    let title = title.to_lowercase();
    [
        "just a moment",
        "um momento",
        "un momento",
        "einen moment",
        "un instant",
        "attention required",
        "checking your browser",
        "verificando",
        "one more step",
    ]
    .iter()
    .any(|marker| title.contains(marker))
}

fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_titles_are_recognized_in_several_languages() {
        assert!(is_challenge_title("Just a moment..."));
        assert!(is_challenge_title("Um momento…"));
        assert!(!is_challenge_title("cover.jpg (300×450)"));
        assert!(!is_challenge_title("Comix - Read manga online"));
    }

    #[test]
    fn a_host_that_gave_up_is_skipped_until_the_cooldown_ends() {
        assert!(!recently_given_up("blocked.example"));
        give_up("blocked.example", BLOCKED_COOLDOWN);
        assert!(recently_given_up("blocked.example"));
        assert!(!recently_given_up("other.example"));
        give_up("", BLOCKED_COOLDOWN);
        assert!(!recently_given_up(""));
        give_up("expired.example", Duration::ZERO);
        assert!(!recently_given_up("expired.example"));
    }

    #[test]
    fn the_window_goes_left_of_every_monitor() {
        assert_eq!(offscreen_x(&[-1920, 1920, 0]), -1920 - OFFSCREEN_GAP);
        assert_eq!(offscreen_x(&[0, 2560]), -OFFSCREEN_GAP);
        assert_eq!(offscreen_x(&[]), -OFFSCREEN_GAP);
    }

    #[test]
    fn the_page_script_uses_the_markers_the_solver_checks() {
        assert!(PAGE_SCRIPT.contains(BLOCKED_TITLE));
        assert!(PAGE_SCRIPT.contains(CANCEL_HOST));
    }
}
