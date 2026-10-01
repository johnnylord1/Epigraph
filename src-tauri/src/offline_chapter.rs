//! Downloaded manga chapters are read page by page, the way Mihon's DownloadPageLoader does: opening a chapter only
//! lists the pages in its CBZ, and the webview reads each page through the `offline-page` protocol when it shows it.
//! No page is base64'd or sent over IPC, so a large chapter opens as quickly as a small one, in any reader window.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::Read;
use std::iter::Peekable;
use std::path::{Path, PathBuf};
use std::str::Chars;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::http::header::{CONTENT_LENGTH, CONTENT_TYPE};
use tauri::http::{Request, Response, StatusCode};

/// Chapters kept open at once: the one being read and the few the reader moved away from.
const OPEN_CHAPTERS_KEPT: usize = 16;

struct OpenChapter {
    id: String,
    archive: PathBuf,
    stamp: (u64, Option<SystemTime>),
    pages: Vec<String>,
}

static OPEN_CHAPTERS: Mutex<VecDeque<Arc<OpenChapter>>> = Mutex::new(VecDeque::new());

#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct OpenedChapter {
    id: String,
    pages: usize,
}

/// Only the app's own windows read downloads; the source reader and novel runtime webviews run untrusted pages.
pub(crate) fn may_read_pages(webview_label: &str) -> bool {
    webview_label == crate::MAIN_WINDOW_LABEL || webview_label.starts_with("detached-reader-")
}

fn is_page(name: &str) -> bool {
    !name.ends_with('/')
        && name
            .rsplit_once('.')
            .map(|(_, extension)| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "avif" | "gif" | "jpeg" | "jpg" | "png" | "webp"
                )
            })
            .unwrap_or(false)
}

fn page_content_type(name: &str) -> &'static str {
    match name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("avif") => "image/avif",
        _ => "image/jpeg",
    }
}

/// Digit runs compare by value, so "2.jpg" comes before "10.jpg"; everything else compares case-insensitively.
fn natural_order(left: &str, right: &str) -> Ordering {
    let (mut left_chars, mut right_chars) = (left.chars().peekable(), right.chars().peekable());
    loop {
        match (left_chars.peek().copied(), right_chars.peek().copied()) {
            (None, None) => return left.cmp(right),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(l), Some(r)) if l.is_ascii_digit() && r.is_ascii_digit() => {
                fn take_number(chars: &mut Peekable<Chars<'_>>) -> String {
                    let mut digits = String::new();
                    while let Some(ch) = chars.peek().copied().filter(char::is_ascii_digit) {
                        digits.push(ch);
                        chars.next();
                    }
                    digits.trim_start_matches('0').to_string()
                }
                let (l, r) = (take_number(&mut left_chars), take_number(&mut right_chars));
                let order = l.len().cmp(&r.len()).then_with(|| l.cmp(&r));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(l), Some(r)) => {
                let order = l.to_lowercase().cmp(r.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                left_chars.next();
                right_chars.next();
            }
        }
    }
}

fn archive_stamp(archive: &Path) -> Result<(u64, Option<SystemTime>), String> {
    let metadata = fs::metadata(archive).map_err(|error| error.to_string())?;
    Ok((metadata.len(), metadata.modified().ok()))
}

fn list_pages(archive: &Path) -> Result<Vec<String>, String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let zip = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut pages: Vec<String> = zip
        .file_names()
        .filter(|name| is_page(name))
        .map(str::to_owned)
        .collect();
    pages.sort_by(|left, right| natural_order(left, right));
    Ok(pages)
}

fn open_archive(archive: PathBuf) -> Result<Option<OpenedChapter>, String> {
    let stamp = archive_stamp(&archive)?;
    let pages = list_pages(&archive)?;
    if pages.is_empty() {
        return Ok(None);
    }
    let mut open = OPEN_CHAPTERS
        .lock()
        .map_err(|_| "Downloaded chapters are unavailable.".to_string())?;
    // Reopening an unchanged archive keeps its page URLs, so the webview can reuse the images it already has.
    let id = open
        .iter()
        .find(|chapter| chapter.archive == archive && chapter.stamp == stamp)
        .map(|chapter| chapter.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    open.retain(|chapter| chapter.id != id && chapter.archive != archive);
    let count = pages.len();
    open.push_back(Arc::new(OpenChapter {
        id: id.clone(),
        archive,
        stamp,
        pages,
    }));
    while open.len() > OPEN_CHAPTERS_KEPT {
        open.pop_front();
    }
    Ok(Some(OpenedChapter { id, pages: count }))
}

/// Finds a downloaded chapter and lists its pages; the pages themselves are read later, one request each.
#[tauri::command]
pub(crate) async fn open_downloaded_chapter(
    downloads_path: String,
    source_name: String,
    manga_title: String,
    chapter_name: String,
    scanlator: Option<String>,
    profile_id: Option<String>,
) -> Result<Option<OpenedChapter>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let archive = crate::find_downloaded_chapter_archive(
            &downloads_path,
            &source_name,
            &manga_title,
            &chapter_name,
            scanlator.as_deref(),
            profile_id.as_deref(),
        )?;
        match archive {
            Some(archive) => open_archive(archive),
            None => Ok(None),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

fn page_error(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(Cow::Borrowed(&[][..]))
        .unwrap()
}

fn read_page(chapter: &OpenChapter, index: usize) -> Option<(Vec<u8>, &'static str)> {
    let name = chapter.pages.get(index)?;
    let mut zip = zip::ZipArchive::new(File::open(&chapter.archive).ok()?).ok()?;
    let mut entry = zip.by_name(name).ok()?;
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut bytes).ok()?;
    Some((bytes, page_content_type(name)))
}

/// Serves `<chapter id>/<page index>` of a chapter opened by `open_downloaded_chapter`.
pub(crate) fn serve_page(
    trusted: bool,
    request: &Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    if !trusted {
        return page_error(StatusCode::FORBIDDEN);
    }
    let path = percent_decode_str(request.uri().path().trim_start_matches('/'))
        .decode_utf8_lossy()
        .into_owned();
    let Some((id, index)) = path.split_once('/') else {
        return page_error(StatusCode::BAD_REQUEST);
    };
    let Ok(index) = index.parse::<usize>() else {
        return page_error(StatusCode::BAD_REQUEST);
    };
    let chapter = OPEN_CHAPTERS
        .lock()
        .ok()
        .and_then(|open| open.iter().find(|chapter| chapter.id == id).cloned());
    let Some(chapter) = chapter else {
        return page_error(StatusCode::NOT_FOUND);
    };
    let Some((bytes, content_type)) = read_page(&chapter, index) else {
        return page_error(StatusCode::NOT_FOUND);
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CONTENT_LENGTH, bytes.len().to_string())
        .header("Cache-Control", "private, max-age=86400")
        .header("Access-Control-Allow-Origin", "*")
        .body(Cow::Owned(bytes))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn write_archive(path: &PathBuf, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn get(uri: &str) -> Request<Vec<u8>> {
        Request::builder().uri(uri).body(Vec::new()).unwrap()
    }

    #[test]
    fn pages_follow_natural_order() {
        let mut names = vec![
            "10.png",
            "2.jpg",
            "001.jpg",
            "b/3.webp",
            "a/3.webp",
            "Page 11.png",
            "page 9.png",
        ];
        names.sort_by(|left, right| natural_order(left, right));
        assert_eq!(
            names,
            vec![
                "001.jpg",
                "2.jpg",
                "10.png",
                "a/3.webp",
                "b/3.webp",
                "page 9.png",
                "Page 11.png"
            ]
        );
    }

    #[test]
    fn opens_an_archive_and_serves_each_page_on_request() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("Chapter 1.cbz");
        write_archive(
            &archive,
            &[
                ("10.png", b"ten"),
                ("notes.txt", b"skip"),
                ("2.jpg", b"two"),
                ("dir/", b""),
            ],
        );

        let opened = open_archive(archive.clone()).unwrap().unwrap();
        assert_eq!(opened.pages, 2);
        // An unchanged archive keeps its id, so its page URLs stay the same.
        assert_eq!(open_archive(archive.clone()).unwrap().unwrap(), opened);

        let first = serve_page(
            true,
            &get(&format!("http://offline-page.localhost/{}%2F0", opened.id)),
        );
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(first.headers().get(CONTENT_TYPE).unwrap(), "image/jpeg");
        assert_eq!(first.body().as_ref(), b"two");
        let second = serve_page(
            true,
            &get(&format!("offline-page://localhost/{}/1", opened.id)),
        );
        assert_eq!(second.headers().get(CONTENT_TYPE).unwrap(), "image/png");
        assert_eq!(second.body().as_ref(), b"ten");

        assert_eq!(
            serve_page(
                true,
                &get(&format!("http://offline-page.localhost/{}%2F2", opened.id))
            )
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve_page(true, &get("http://offline-page.localhost/unknown%2F0")).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve_page(
                true,
                &get(&format!("http://offline-page.localhost/{}%2Fx", opened.id))
            )
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            serve_page(
                false,
                &get(&format!("http://offline-page.localhost/{}%2F0", opened.id))
            )
            .status(),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn an_archive_without_pages_does_not_open() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("Empty.cbz");
        write_archive(&archive, &[("ComicInfo.xml", b"<ComicInfo/>")]);
        assert_eq!(open_archive(archive).unwrap(), None);
    }

    #[test]
    fn only_the_app_windows_read_downloads() {
        assert!(may_read_pages("main"));
        assert!(may_read_pages("detached-reader-7"));
        assert!(!may_read_pages("reader-webview"));
        assert!(!may_read_pages("novel-runtime-host"));
        assert!(!may_read_pages("tracker-oauth"));
    }
}
