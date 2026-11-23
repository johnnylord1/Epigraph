use std::{future::Future, sync::Mutex, time::Duration};

use reqwest::{
    header::CONTENT_TYPE,
    multipart::{Form, Part},
    Client, Response, Url,
};
use serde::Deserialize;
use tauri::{
    ipc::{InvokeBody, Request},
    plugin::{Builder, TauriPlugin},
    AppHandle, Emitter, Manager, Runtime, State,
};

const MAX_PNG_BYTES: usize = 16 * 1024 * 1024;
const MAX_REPLY_BYTES: usize = 16 * 1024;
const HOST_TIMEOUT: Duration = Duration::from_secs(15);
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const SHARE_PNG_CHUNK_KEYWORD: &[u8] = b"epigraph-share";
const FREEIMAGE_PUBLIC_API_KEY: &str = "6d207e02198a847aa98d0a2a901485a5";
pub const SHARE_IMPORT_LINK_EVENT: &str = "epigraph:share-import-link";

#[derive(Default)]
pub struct PendingImportLinkState(Mutex<Option<String>>);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Host {
    Freeimage,
    Kappa,
    Pomf2,
    X0At,
    Uguu,
    Catbox,
    Litterbox,
}

impl Host {
    fn upload_request(self, png: &[u8]) -> Option<(&'static str, Form)> {
        let image = Part::bytes(png.to_vec())
            .file_name("epigraph-library.png")
            .mime_str("image/png")
            .ok()?;
        let form = Form::new();
        Some(match self {
            Self::Freeimage => (
                "https://freeimage.host/api/1/upload",
                form.text("key", FREEIMAGE_PUBLIC_API_KEY)
                    .text("action", "upload")
                    .text("format", "json")
                    .part("source", image),
            ),
            Self::Kappa => ("https://kappa.lol/api/upload", form.part("file", image)),
            Self::Pomf2 => ("https://pomf2.lain.la/upload.php", form.part("files[]", image)),
            Self::X0At => ("https://x0.at/", form.part("file", image)),
            Self::Litterbox => (
                "https://litterbox.catbox.moe/resources/internals/api.php",
                form.text("reqtype", "fileupload")
                    .text("time", "72h")
                    .part("fileToUpload", image),
            ),
            Self::Uguu => ("https://uguu.se/upload", form.part("files[]", image)),
            Self::Catbox => (
                "https://catbox.moe/user/api.php",
                form.text("reqtype", "fileupload")
                    .part("fileToUpload", image),
            ),
        })
    }

    fn public_url(self, reply: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct PomfUpload {
            success: bool,
            files: Vec<PomfFile>,
        }

        #[derive(Deserialize)]
        struct PomfFile {
            url: String,
        }

        #[derive(Deserialize)]
        struct KappaUpload {
            id: String,
            ext: String,
        }

        #[derive(Deserialize)]
        struct FreeimageUpload {
            status_code: u16,
            image: FreeimageData,
        }

        #[derive(Deserialize)]
        struct FreeimageData {
            url: Option<String>,
            id_encoded: Option<String>,
            extension_name: Option<String>,
        }

        let candidate = match self {
            Self::Uguu | Self::Pomf2 => {
                let reply: PomfUpload = serde_json::from_str(reply).ok()?;
                if !reply.success {
                    return None;
                }
                reply.files.into_iter().next()?.url
            }
            Self::Kappa => {
                let reply: KappaUpload = serde_json::from_str(reply).ok()?;
                if reply.ext != ".png" || !is_valid_id(&reply.id) {
                    return None;
                }
                format!("https://kappa.lol/{}.png", reply.id)
            }
            Self::Freeimage => {
                let reply: FreeimageUpload = serde_json::from_str(reply).ok()?;
                if reply.status_code != 200 {
                    return None;
                }
                if let Some(url) = reply.image.url {
                    url
                } else if reply.image.extension_name.as_deref() == Some("png") {
                    let id = reply.image.id_encoded?;
                    format!("https://iili.io/{id}.png")
                } else {
                    return None;
                }
            }
            _ => reply.trim().to_owned(),
        };
        let url = Url::parse(&candidate).ok()?;
        let host = url.host_str()?;
        let expected_host = match self {
            Self::Freeimage => host == "iili.io",
            Self::Kappa => host == "kappa.lol",
            Self::Pomf2 => host == "pomf2.lain.la",
            Self::X0At => host == "x0.at",
            Self::Litterbox => host == "litter.catbox.moe",
            Self::Uguu => host.strip_suffix(".uguu.se").is_some_and(|prefix| {
                !prefix.is_empty() && prefix.bytes().all(|byte| byte.is_ascii_alphanumeric())
            }),
            Self::Catbox => host == "files.catbox.moe",
        };
        let path_prefix = match self {
            Self::Pomf2 => "/f/",
            _ => "/",
        };
        let filename = url.path().strip_prefix(path_prefix)?.strip_suffix(".png")?;
        // Each service returns a generated filename at the expected path of its image host.
        if expected_host
            && url.scheme() == "https"
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && !filename.is_empty()
            && filename
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            Some(url.into())
        } else {
            None
        }
    }
}

fn is_valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_valid_inline_token(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("d.") else {
        return false;
    };
    (8..=1_400_000).contains(&rest.len())
        && rest
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Strictly maps a hosted share pointer token (`i.<id>`, `k.<id>`, `p.<id>`, `a.<id>`, `l.<id>`,
/// `c.<id>`, `u.<sub>.<id>`) to its allowlisted HTTPS PNG URL. Rejects any arbitrary URL or unknown host.
pub fn resolve_hosted_token_url(token: &str) -> Option<String> {
    let trimmed = token.trim();
    if let Some(id) = trimmed.strip_prefix("i.") {
        return is_valid_id(id).then(|| format!("https://iili.io/{id}.png"));
    }
    if let Some(id) = trimmed.strip_prefix("k.") {
        return is_valid_id(id).then(|| format!("https://kappa.lol/{id}.png"));
    }
    if let Some(id) = trimmed.strip_prefix("p.") {
        return is_valid_id(id).then(|| format!("https://pomf2.lain.la/f/{id}.png"));
    }
    if let Some(id) = trimmed.strip_prefix("a.") {
        return is_valid_id(id).then(|| format!("https://x0.at/{id}.png"));
    }
    if let Some(id) = trimmed.strip_prefix("l.") {
        return is_valid_id(id).then(|| format!("https://litter.catbox.moe/{id}.png"));
    }
    if let Some(id) = trimmed.strip_prefix("c.") {
        return is_valid_id(id).then(|| format!("https://files.catbox.moe/{id}.png"));
    }
    if let Some(rest) = trimmed.strip_prefix("u.") {
        let (sub, id) = rest.split_once('.')?;
        if !sub.is_empty()
            && sub.len() <= 16
            && sub.bytes().all(|byte| byte.is_ascii_alphanumeric())
            && is_valid_id(id)
        {
            return Some(format!("https://{sub}.uguu.se/{id}.png"));
        }
    }
    None
}

/// Extracts the `epigraph-share` `tEXt` chunk token from a PNG byte slice.
pub fn extract_share_token_from_png(png: &[u8]) -> Option<String> {
    if png.len() < 33 || !png.starts_with(PNG_SIGNATURE) {
        return None;
    }
    let mut offset = 8usize;
    while offset + 12 <= png.len() {
        let length = u32::from_be_bytes(png[offset..offset + 4].try_into().ok()?) as usize;
        let chunk_type = &png[offset + 4..offset + 8];
        let data_start = offset + 8;
        let data_end = data_start.checked_add(length)?;
        let next = data_end.checked_add(4)?;
        if next > png.len() {
            return None;
        }
        if chunk_type == b"tEXt" {
            let data = &png[data_start..data_end];
            if let Some(sep) = data.iter().position(|byte| *byte == 0) {
                if &data[..sep] == SHARE_PNG_CHUNK_KEYWORD {
                    let token = std::str::from_utf8(&data[sep + 1..]).ok()?.trim();
                    if is_valid_inline_token(token) {
                        return Some(token.to_owned());
                    }
                    return None;
                }
            }
        }
        if chunk_type == b"IEND" {
            break;
        }
        offset = next;
    }
    None
}

pub fn is_epigraph_import_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    let Ok(url) = Url::parse(trimmed) else {
        return false;
    };
    url.scheme().eq_ignore_ascii_case("epigraph")
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("import"))
}

pub fn extract_import_link_from_args<'a>(args: impl IntoIterator<Item = &'a str>) -> Option<String> {
    args.into_iter()
        .map(str::trim)
        .find(|arg| is_epigraph_import_url(arg))
        .map(str::to_owned)
}

pub fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn handle_incoming_import_link<R: Runtime>(app: &AppHandle<R>, raw_url: &str) {
    let trimmed = raw_url.trim();
    if !is_epigraph_import_url(trimmed) {
        return;
    }
    if let Some(state) = app.try_state::<PendingImportLinkState>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(trimmed.to_owned());
        }
    }
    focus_main_window(app);
    let _ = app.emit_to("main", SHARE_IMPORT_LINK_EVENT, trimmed);
}

async fn read_reply(mut response: Response) -> Option<String> {
    if !response.status().is_success() {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > MAX_REPLY_BYTES {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).ok()
}

async fn read_png_bytes(mut response: Response) -> Option<Vec<u8>> {
    if !response.status().is_success() {
        return None;
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)?
        .to_str()
        .ok()?;
    if content_type.split(';').next()?.trim() != "image/png" {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > MAX_PNG_BYTES {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    Some(body)
}

async fn try_upload(client: &Client, host: Host, png: &[u8]) -> Option<String> {
    let (endpoint, form) = host.upload_request(png)?;
    let response = client.post(endpoint).multipart(form).send().await.ok()?;
    let url = host.public_url(&read_reply(response).await?)?;

    // A successful upload can still point to an error page, download landing page, or a zero-length
    // HEAD reply (which breaks Discord's media proxy preview).
    let image = client.head(&url).send().await.ok()?;
    let content_type = image.headers().get(CONTENT_TYPE)?.to_str().ok()?;
    let non_empty = image
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_none_or(|len| len > 0);
    (image.status().is_success() && content_type.split(';').next()?.trim() == "image/png" && non_empty)
        .then_some(url)
}

async fn first_available<F, Fut>(mut attempt: F) -> Option<String>
where
    F: FnMut(Host) -> Fut,
    Fut: Future<Output = Option<String>>,
{
    // Prefer permanent and long-lived hosts whose HEAD replies embed cleanly in Discord first.
    for host in [
        Host::Freeimage,
        Host::Kappa,
        Host::Pomf2,
        Host::X0At,
        Host::Uguu,
        Host::Catbox,
        Host::Litterbox,
    ] {
        if let Ok(Some(url)) = tokio::time::timeout(HOST_TIMEOUT, attempt(host)).await {
            return Some(url);
        }
    }
    None
}

#[tauri::command]
async fn upload_card(request: Request<'_>) -> Result<String, &'static str> {
    let InvokeBody::Raw(png) = request.body() else {
        return Err("invalid_image");
    };
    if png.len() > MAX_PNG_BYTES || !png.starts_with(PNG_SIGNATURE) {
        return Err("invalid_image");
    }

    let client = Client::builder()
        .user_agent("Epigraph/LibraryShare")
        .connect_timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "upload_failed")?;
    first_available(|host| try_upload(&client, host, png))
        .await
        .ok_or("upload_failed")
}

#[tauri::command]
async fn fetch_share_payload(token: String) -> Result<String, &'static str> {
    let url = resolve_hosted_token_url(&token).ok_or("invalid_token")?;
    let client = Client::builder()
        .user_agent("Epigraph/LibraryShare")
        .connect_timeout(Duration::from_secs(5))
        .timeout(HOST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "fetch_failed")?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|_| "fetch_failed")?;
    let png = read_png_bytes(response).await.ok_or("fetch_failed")?;
    extract_share_token_from_png(&png).ok_or("missing_payload")
}

#[tauri::command]
fn take_pending_import_link(state: State<'_, PendingImportLinkState>) -> Option<String> {
    state.0.lock().ok().and_then(|mut guard| guard.take())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("library-share")
        .setup(|app, _api| {
            app.manage(PendingImportLinkState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            upload_card,
            fetch_share_payload,
            take_pending_import_link,
        ])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::ready;

    #[tokio::test]
    async fn tries_each_host_until_a_public_image_is_available() {
        let mut attempts = Vec::new();
        let uploaded = first_available(|host| {
            attempts.push(host);
            ready(match host {
                Host::Litterbox => Some("https://litter.catbox.moe/example.png".into()),
                _ => None,
            })
        })
        .await;

        assert_eq!(
            attempts,
            [
                Host::Freeimage,
                Host::Kappa,
                Host::Pomf2,
                Host::X0At,
                Host::Uguu,
                Host::Catbox,
                Host::Litterbox,
            ],
        );
        assert_eq!(uploaded.as_deref(), Some("https://litter.catbox.moe/example.png"));
    }

    #[tokio::test]
    async fn stops_at_the_first_success_and_reports_total_failure() {
        let mut attempts = Vec::new();
        let uploaded = first_available(|host| {
            attempts.push(host);
            ready(Some("https://iili.io/oKis7El.png".into()))
        })
        .await;

        assert!(uploaded.is_some());
        assert_eq!(attempts, [Host::Freeimage]);
        assert_eq!(first_available(|_| ready(None)).await, None);
    }

    #[test]
    fn accepts_only_direct_https_png_urls_from_each_host() {
        assert_eq!(
            Host::Freeimage
                .public_url(r#"{"status_code":200,"image":{"url":"https://iili.io/oKis7El.png"}}"#)
                .as_deref(),
            Some("https://iili.io/oKis7El.png"),
        );
        assert_eq!(
            Host::Kappa
                .public_url(r#"{"id":"lfAoW8","ext":".png","link":"https://kappa.lol/lfAoW8"}"#)
                .as_deref(),
            Some("https://kappa.lol/lfAoW8.png"),
        );
        assert_eq!(
            Host::Pomf2
                .public_url(r#"{"success":true,"files":[{"url":"https://pomf2.lain.la/f/n6bzrnex.png"}]}"#)
                .as_deref(),
            Some("https://pomf2.lain.la/f/n6bzrnex.png"),
        );
        assert_eq!(
            Host::X0At.public_url(" https://x0.at/dFhZ.png\n").as_deref(),
            Some("https://x0.at/dFhZ.png"),
        );
        assert_eq!(
            Host::Litterbox.public_url(" https://litter.catbox.moe/file1.png\n").as_deref(),
            Some("https://litter.catbox.moe/file1.png"),
        );
        assert_eq!(
            Host::Uguu.public_url(r#"{"success":true,"files":[{"url":"https://h.uguu.se/A1.png"}]}"#).as_deref(),
            Some("https://h.uguu.se/A1.png"),
        );
        for response in [
            "<html>Upload failed</html>",
            "http://files.catbox.moe/file.png",
            "https://files.catbox.moe.example.com/file.png",
            "https://files.catbox.moe:1234/file.png",
            "https://user@files.catbox.moe/file.png",
            "https://files.catbox.moe/folder/file.png",
            "https://files.catbox.moe/file.png?anything",
            "https://files.catbox.moe/file.html",
        ] {
            assert_eq!(Host::Catbox.public_url(response), None, "{response}");
        }
        assert_eq!(
            Host::Uguu.public_url(r#"{"success":false,"files":[{"url":"https://h.uguu.se/A1.png"}]}"#),
            None,
        );
    }

    #[test]
    fn resolves_allowlisted_hosted_tokens_only() {
        assert_eq!(
            resolve_hosted_token_url("i.oKis7El").as_deref(),
            Some("https://iili.io/oKis7El.png"),
        );
        assert_eq!(
            resolve_hosted_token_url("k.lfAoW8").as_deref(),
            Some("https://kappa.lol/lfAoW8.png"),
        );
        assert_eq!(
            resolve_hosted_token_url("p.n6bzrnex").as_deref(),
            Some("https://pomf2.lain.la/f/n6bzrnex.png"),
        );
        assert_eq!(
            resolve_hosted_token_url("a.dFhZ").as_deref(),
            Some("https://x0.at/dFhZ.png"),
        );
        assert_eq!(
            resolve_hosted_token_url("l.abc123").as_deref(),
            Some("https://litter.catbox.moe/abc123.png"),
        );
        assert_eq!(
            resolve_hosted_token_url("c.xyz_9").as_deref(),
            Some("https://files.catbox.moe/xyz_9.png"),
        );
        assert_eq!(
            resolve_hosted_token_url("u.d.XArdEvq").as_deref(),
            Some("https://d.uguu.se/XArdEvq.png"),
        );
        for bad in ["l.a/b", "u.bad-sub.abc", "x.abc", "https://evil.com/a.png", ""] {
            assert_eq!(resolve_hosted_token_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn extracts_embedded_share_token_from_png_text_chunk() {
        let token = "d.H4sIAAAAAAAAA1234567890";
        let mut chunk_data = Vec::new();
        chunk_data.extend_from_slice(SHARE_PNG_CHUNK_KEYWORD);
        chunk_data.push(0);
        chunk_data.extend_from_slice(token.as_bytes());

        let mut png = Vec::new();
        png.extend_from_slice(PNG_SIGNATURE);
        // Minimal IHDR chunk (13 zero bytes)
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&[0u8; 13]);
        png.extend_from_slice(&[0u8; 4]);
        // tEXt chunk
        png.extend_from_slice(&(chunk_data.len() as u32).to_be_bytes());
        png.extend_from_slice(b"tEXt");
        png.extend_from_slice(&chunk_data);
        png.extend_from_slice(&[0u8; 4]);
        // IEND chunk
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0u8; 4]);

        assert_eq!(extract_share_token_from_png(&png).as_deref(), Some(token));
    }

    #[test]
    fn extracts_epigraph_import_link_from_cli_args() {
        let found = extract_import_link_from_args([
            "epigraph.exe",
            "--flag",
            "epigraph://import?p=l.abc123",
        ]);
        assert_eq!(found.as_deref(), Some("epigraph://import?p=l.abc123"));
        assert_eq!(
            extract_import_link_from_args(["epigraph.exe", "epigraph://pair?b=1234"]),
            None,
        );
    }
}
