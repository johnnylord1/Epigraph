//! Gzip for the bulk sync routes (`supportsGzipRequestBodiesV1`).
//!
//! A first sync moves thousands of progress records whose JSON repeats long ids and portable
//! references, so it compresses about tenfold. On a mesh Wi-Fi of several repeaters the bytes, not
//! the desktop, are what a phone waits on. Only buffered JSON routes are covered: the SSE stream,
//! the Suwayomi proxy and asset transfers keep their own encoding.

use std::io::{Read, Write};

use axum::body::{to_bytes, Body};
use axum::extract::Request;
use axum::http::header::{ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, VARY};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

/// Routes whose request and response bodies are whole JSON documents.
const GZIP_PATHS: &[&str] = &[
    "/v4/sync/bulk",
    "/v4/deltas",
    "/v4/changes",
    "/v4/snapshot",
];
/// Compressed request bodies above this are refused before they are inflated.
const MAX_COMPRESSED_REQUEST_BYTES: usize = 8 * 1024 * 1024;
/// Inflated request bodies above this are refused; route extractors still apply their own limits.
const MAX_INFLATED_REQUEST_BYTES: usize = 32 * 1024 * 1024;
/// Smaller responses are not worth the gzip header and the CPU.
const MIN_COMPRESSED_RESPONSE_BYTES: usize = 1024;
/// Responses are buffered to compress them; anything larger passes through unchanged.
const MAX_COMPRESSED_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

pub async fn gzip_sync_bodies(request: Request, next: Next) -> Response {
    if !GZIP_PATHS.contains(&request.uri().path()) {
        return next.run(request).await;
    }
    let accepts_gzip = header_lists_gzip(request.headers().get(ACCEPT_ENCODING));
    let request = match inflate_request(request).await {
        Ok(request) => request,
        Err(status) => return status.into_response(),
    };
    let response = next.run(request).await;
    if !accepts_gzip {
        return response;
    }
    compress_response(response).await
}

fn header_lists_gzip(value: Option<&HeaderValue>) -> bool {
    value
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|coding| {
                let mut parts = coding.split(';');
                let name = parts.next().unwrap_or_default().trim();
                let refused = parts.any(|param| {
                    param
                        .trim()
                        .strip_prefix("q=")
                        .and_then(|q| q.trim().parse::<f32>().ok())
                        .is_some_and(|q| q <= 0.0)
                });
                name.eq_ignore_ascii_case("gzip") && !refused
            })
        })
}

async fn inflate_request(request: Request) -> Result<Request, StatusCode> {
    let Some(encoding) = request.headers().get(CONTENT_ENCODING) else {
        return Ok(request);
    };
    let encoding = encoding
        .to_str()
        .map_err(|_| StatusCode::UNSUPPORTED_MEDIA_TYPE)?
        .trim();
    if encoding.eq_ignore_ascii_case("identity") {
        return Ok(request);
    }
    if !encoding.eq_ignore_ascii_case("gzip") {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let (mut parts, body) = request.into_parts();
    let compressed = to_bytes(body, MAX_COMPRESSED_REQUEST_BYTES)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    let inflated = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, StatusCode> {
        let mut inflated = Vec::with_capacity(compressed.len() * 8);
        GzDecoder::new(&compressed[..])
            .take(MAX_INFLATED_REQUEST_BYTES as u64 + 1)
            .read_to_end(&mut inflated)
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        if inflated.len() > MAX_INFLATED_REQUEST_BYTES {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        Ok(inflated)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;
    parts.headers.remove(CONTENT_ENCODING);
    parts.headers.remove(CONTENT_LENGTH);
    Ok(Request::from_parts(parts, Body::from(inflated)))
}

async fn compress_response(response: Response) -> Response {
    let is_json = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    if !is_json || response.headers().contains_key(CONTENT_ENCODING) {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let bytes = match to_bytes(body, MAX_COMPRESSED_RESPONSE_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    parts
        .headers
        .append(VARY, HeaderValue::from_static("accept-encoding"));
    if bytes.len() < MIN_COMPRESSED_RESPONSE_BYTES {
        return Response::from_parts(parts, Body::from(bytes));
    }
    let compressed = tokio::task::spawn_blocking(move || {
        // Level 3 keeps most of the ratio of the default level at a fraction of its CPU.
        let mut encoder = GzEncoder::new(Vec::with_capacity(bytes.len() / 6), Compression::new(3));
        encoder.write_all(&bytes).and_then(|()| encoder.finish())
    })
    .await;
    match compressed {
        Ok(Ok(compressed)) => {
            parts.headers.remove(CONTENT_LENGTH);
            parts
                .headers
                .insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
            Response::from_parts(parts, Body::from(compressed))
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gzip_is_accepted_unless_its_quality_is_zero() {
        let accepts = |value: &str| header_lists_gzip(Some(&HeaderValue::from_str(value).unwrap()));
        assert!(accepts("gzip"));
        assert!(accepts("br, GZIP;q=0.5"));
        assert!(accepts("deflate, gzip"));
        assert!(!accepts("gzip;q=0"));
        assert!(!accepts("deflate"));
        assert!(!accepts("x-gzip-like"));
        assert!(!header_lists_gzip(None));
    }
}
