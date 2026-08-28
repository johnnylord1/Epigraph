use crate::{books_data_dir, library_cover_cache_dir};
use futures_util::StreamExt;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::{self, FilterType};
use image::ImageReader;
use image::{DynamicImage, GenericImageView, ImageBuffer, Limits, Rgba, RgbaImage};
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use reqwest::{multipart, redirect, Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const CANVAS_SIZE: u32 = 1024;
const FOREGROUND_MARGIN: u32 = 12;
const FOREGROUND_NARROW_ASPECT_THRESHOLD: f32 = 0.84;
const FOREGROUND_NARROW_MIN_WIDTH: u32 = 860;
const FOREGROUND_NARROW_MAX_HEIGHT: u32 = 1360;
const BACKGROUND_ZOOM: f32 = 1.16;
const BACKGROUND_BLUR_SIGMA: f32 = 60.0;
const DARK_OVERLAY_ALPHA: u8 = 194;
const MAX_DOWNLOAD_BYTES: u64 = 12 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 768 * 1024;
const MAX_SOURCE_DIMENSION: u32 = 12_000;
const MAX_SOURCE_PIXELS: u64 = 80_000_000;
const COVER_DOWNLOAD_TIMEOUT_SECONDS: u64 = 10;
const COVER_UPLOAD_TIMEOUT_SECONDS: u64 = 15;
const MAX_UPLOAD_TTL_MS: u64 = 72 * 60 * 60 * 1000;
const UGUU_TTL_MS: u64 = 3 * 60 * 60 * 1000;
const UGUU_UPLOAD_URL: &str = "https://uguu.se/upload.php";
const COVER_HTTP_USER_AGENT: &str = "Epigraph/DiscordRichPresence";
const DISCORD_COVER_UPLOAD_URL_ENV: &str = "EPIGRAPH_DISCORD_COVER_UPLOAD_URL";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordCoverRequest {
    pub source_url: Option<String>,
    pub local_path: Option<String>,
    pub trusted_local_base_url: Option<String>,
    pub auth_header: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordCoverResponse {
    pub url: String,
    pub expires_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonCoverUploadResponse {
    url: String,
    expires_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct UguuUploadResponse {
    success: bool,
    files: Vec<UguuUploadedFile>,
}

#[derive(Debug, Deserialize)]
struct UguuUploadedFile {
    url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DiscordCoverUploadTarget {
    Uguu(Url),
    JsonEndpoint(Url),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UrlTrust {
    PublicHttps,
    TrustedLocal,
}

#[tauri::command]
pub async fn optimize_discord_cover(
    input: DiscordCoverRequest,
) -> Result<DiscordCoverResponse, String> {
    let upload_target = discord_cover_upload_target()?;
    let bytes = if let Some(path) = input
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        read_allowed_local_cover(path)?
    } else if let Some(url) = input
        .source_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        download_allowed_cover(
            url,
            input.trusted_local_base_url.as_deref(),
            input.auth_header.as_deref(),
        )
        .await?
    } else {
        return Err("Missing Discord cover source.".to_string());
    };

    let composed = compose_discord_cover(&bytes)?;
    upload_discord_cover(composed, upload_target).await
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => {
            value.is_private()
                || value.is_loopback()
                || value.is_link_local()
                || value.is_broadcast()
                || value.is_multicast()
                || value.is_unspecified()
        }
        IpAddr::V6(value) => {
            value.is_loopback()
                || value.is_unspecified()
                || value.is_multicast()
                || (value.segments()[0] & 0xfe00) == 0xfc00
                || (value.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

fn host_looks_private(host: &str) -> bool {
    let normalized = host.trim_matches(['[', ']']).to_ascii_lowercase();
    normalized == "localhost"
        || normalized == "0.0.0.0"
        || normalized.ends_with(".local")
        || normalized.parse::<IpAddr>().is_ok_and(is_blocked_ip)
}

fn resolve_public_host(url: &Url) -> Result<(), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "URL is missing a host.".to_string())?;
    if host_looks_private(host) {
        return Err("Private cover hosts are not allowed.".to_string());
    }

    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|_| "Could not resolve cover host.".to_string())?;
    let mut saw_address = false;
    for address in addresses {
        saw_address = true;
        if is_blocked_ip(address.ip()) {
            return Err("Cover host resolved to a private address.".to_string());
        }
    }
    if !saw_address {
        return Err("Cover host did not resolve.".to_string());
    }
    Ok(())
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme().eq_ignore_ascii_case(right.scheme())
        && left.host_str().map(str::to_ascii_lowercase)
            == right.host_str().map(str::to_ascii_lowercase)
        && left.port_or_known_default() == right.port_or_known_default()
}

fn validate_source_url(
    raw: &str,
    trusted_local_base_url: Option<&str>,
) -> Result<(Url, UrlTrust), String> {
    let url = Url::parse(raw).map_err(|err| err.to_string())?;

    if url.scheme() == "https" {
        resolve_public_host(&url)?;
        return Ok((url, UrlTrust::PublicHttps));
    }

    if matches!(url.scheme(), "http" | "https") {
        if let Some(base) = trusted_local_base_url.and_then(|value| Url::parse(value).ok()) {
            if same_origin(&url, &base) {
                return Ok((url, UrlTrust::TrustedLocal));
            }
        }
    }

    Err("Discord cover URL is not an allowed public or trusted local source.".to_string())
}

fn validate_redirect_url(
    raw: &str,
    trust: UrlTrust,
    trusted_local_base_url: Option<&str>,
) -> Result<Url, String> {
    let (url, next_trust) = validate_source_url(raw, trusted_local_base_url)?;
    if next_trust != trust {
        return Err("Cover redirects cannot cross trust boundaries.".to_string());
    }
    Ok(url)
}

fn validate_before_public_request(url: &Url, trust: UrlTrust) -> Result<(), String> {
    if trust == UrlTrust::PublicHttps {
        resolve_public_host(url)?;
    }
    Ok(())
}

fn allowed_local_roots() -> Vec<PathBuf> {
    [books_data_dir().join("covers"), library_cover_cache_dir()]
        .into_iter()
        .filter_map(|path| path.canonicalize().ok())
        .collect()
}

fn read_allowed_local_cover(raw_path: &str) -> Result<Vec<u8>, String> {
    let candidate = PathBuf::from(raw_path);
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "Discord cover file was not found.".to_string())?;
    let allowed = allowed_local_roots()
        .into_iter()
        .any(|root| canonical.starts_with(root));
    if !allowed {
        return Err("Discord cover file is outside the allowed scope.".to_string());
    }

    let metadata = fs::metadata(&canonical).map_err(|err| err.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_DOWNLOAD_BYTES {
        return Err("Discord cover file is not a supported size.".to_string());
    }
    fs::read(canonical).map_err(|err| err.to_string())
}

fn build_cover_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .user_agent(COVER_HTTP_USER_AGENT)
        .timeout(timeout)
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|err| err.to_string())
}

async fn download_allowed_cover(
    raw_url: &str,
    trusted_local_base_url: Option<&str>,
    auth_header: Option<&str>,
) -> Result<Vec<u8>, String> {
    let (mut url, trust) = validate_source_url(raw_url, trusted_local_base_url)?;
    let client = build_cover_client(Duration::from_secs(COVER_DOWNLOAD_TIMEOUT_SECONDS))?;

    for _ in 0..=3 {
        validate_before_public_request(&url, trust)?;
        let mut request = client.get(url.clone()).header("Accept", "image/*");
        if trust == UrlTrust::TrustedLocal {
            if let Some(header) = auth_header.map(str::trim).filter(|value| !value.is_empty()) {
                request = request.header(AUTHORIZATION, header);
            }
        }

        let response = request.send().await.map_err(|err| err.to_string())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Cover redirect is missing Location.".to_string())?;
            let next_url = url.join(location).map_err(|err| err.to_string())?;
            url = validate_redirect_url(next_url.as_str(), trust, trusted_local_base_url)?;
            continue;
        }

        if response.status() != StatusCode::OK {
            return Err("Cover source did not return a successful response.".to_string());
        }

        if let Some(length) = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
        {
            if length == 0 || length > MAX_DOWNLOAD_BYTES {
                return Err("Cover source is too large.".to_string());
            }
        }

        if let Some(content_type) = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
        {
            let media_type = content_type
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            if !media_type.is_empty() && !media_type.starts_with("image/") {
                return Err("Cover source is not an image.".to_string());
            }
        }

        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|err| err.to_string())?;
            if bytes.len().saturating_add(chunk.len()) as u64 > MAX_DOWNLOAD_BYTES {
                return Err("Cover source is too large.".to_string());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err("Cover source returned an empty image.".to_string());
        }
        return Ok(bytes);
    }

    Err("Cover source redirected too many times.".to_string())
}

fn exif_orientation(bytes: &[u8]) -> Option<u32> {
    let mut cursor = Cursor::new(bytes);
    let exif = exif::Reader::new().read_from_container(&mut cursor).ok()?;
    let field = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?;
    field.value.get_uint(0)
}

fn apply_orientation(image: DynamicImage, orientation: Option<u32>) -> DynamicImage {
    match orientation {
        Some(2) => image.fliph(),
        Some(3) => image.rotate180(),
        Some(4) => image.flipv(),
        Some(5) => image.rotate90().fliph(),
        Some(6) => image.rotate90(),
        Some(7) => image.rotate270().fliph(),
        Some(8) => image.rotate270(),
        _ => image,
    }
}

fn center_crop_to_canvas(image: RgbaImage) -> RgbaImage {
    let crop_width = image.width().min(CANVAS_SIZE);
    let crop_height = image.height().min(CANVAS_SIZE);
    let crop_x = image.width().saturating_sub(crop_width) / 2;
    let crop_y = image.height().saturating_sub(crop_height) / 2;
    imageops::crop_imm(&image, crop_x, crop_y, crop_width, crop_height).to_image()
}

fn resize_foreground(image: &DynamicImage, max_width: u32, max_height: u32) -> RgbaImage {
    let (width, height) = image.dimensions();
    let contain_scale = (max_width as f32 / width as f32).min(max_height as f32 / height as f32);
    let aspect = width as f32 / height as f32;
    let mut scale = contain_scale;

    if aspect < FOREGROUND_NARROW_ASPECT_THRESHOLD {
        let readable_scale = (FOREGROUND_NARROW_MIN_WIDTH as f32 / width as f32)
            .min(FOREGROUND_NARROW_MAX_HEIGHT as f32 / height as f32);
        scale = scale.max(readable_scale);
    }

    let next_width = ((width as f32 * scale).round() as u32).max(1);
    let next_height = ((height as f32 * scale).round() as u32).max(1);
    center_crop_to_canvas(
        image
            .resize_exact(next_width, next_height, FilterType::Lanczos3)
            .to_rgba8(),
    )
}

fn resize_background(image: &DynamicImage) -> RgbaImage {
    let (width, height) = image.dimensions();
    let scale = (CANVAS_SIZE as f32 / width as f32).max(CANVAS_SIZE as f32 / height as f32)
        * BACKGROUND_ZOOM;
    let next_width = ((width as f32 * scale).ceil() as u32).max(CANVAS_SIZE);
    let next_height = ((height as f32 * scale).ceil() as u32).max(CANVAS_SIZE);
    image
        .resize_exact(next_width, next_height, FilterType::Lanczos3)
        .to_rgba8()
}

fn darken_background(image: &mut RgbaImage) {
    let alpha = u16::from(DARK_OVERLAY_ALPHA);
    for pixel in image.pixels_mut() {
        pixel.0[0] = ((u16::from(pixel.0[0]) * (255 - alpha)) / 255) as u8;
        pixel.0[1] = ((u16::from(pixel.0[1]) * (255 - alpha)) / 255) as u8;
        pixel.0[2] = ((u16::from(pixel.0[2]) * (255 - alpha)) / 255) as u8;
        pixel.0[3] = 255;
    }
}

fn overlay_center(canvas: &mut RgbaImage, image: &RgbaImage) {
    let x = ((CANVAS_SIZE.saturating_sub(image.width())) / 2) as i64;
    let y = ((CANVAS_SIZE.saturating_sub(image.height())) / 2) as i64;
    imageops::overlay(canvas, image, x, y);
}

fn add_foreground_shadow(canvas: &mut RgbaImage, foreground: &RgbaImage) {
    let shadow_width = foreground.width().saturating_add(10).min(CANVAS_SIZE);
    let shadow_height = foreground.height().saturating_add(10).min(CANVAS_SIZE);
    let mut shadow = ImageBuffer::from_pixel(shadow_width, shadow_height, Rgba([0, 0, 0, 48]));
    shadow = DynamicImage::ImageRgba8(shadow).blur(8.0).to_rgba8();
    overlay_center(canvas, &shadow);
}

pub(crate) fn compose_discord_cover(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err("Discord cover image is not a supported size.".to_string());
    }

    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "Discord cover image format could not be detected.".to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SOURCE_DIMENSION);
    limits.max_image_height = Some(MAX_SOURCE_DIMENSION);
    limits.max_alloc = Some(MAX_SOURCE_PIXELS.saturating_mul(4));
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| "Discord cover image could not be decoded.".to_string())?;
    let image = apply_orientation(image, exif_orientation(bytes));
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err("Discord cover image has invalid dimensions.".to_string());
    }
    if u64::from(width).saturating_mul(u64::from(height)) > MAX_SOURCE_PIXELS {
        return Err("Discord cover image is too large.".to_string());
    }

    let mut background = resize_background(&image);
    let crop_x = background.width().saturating_sub(CANVAS_SIZE) / 2;
    let crop_y = background.height().saturating_sub(CANVAS_SIZE) / 2;
    let mut canvas =
        imageops::crop(&mut background, crop_x, crop_y, CANVAS_SIZE, CANVAS_SIZE).to_image();
    canvas = DynamicImage::ImageRgba8(canvas)
        .blur(BACKGROUND_BLUR_SIGMA)
        .to_rgba8();
    darken_background(&mut canvas);

    let foreground_limit = CANVAS_SIZE.saturating_sub(FOREGROUND_MARGIN * 2);
    let foreground = resize_foreground(&image, foreground_limit, foreground_limit);
    add_foreground_shadow(&mut canvas, &foreground);
    overlay_center(&mut canvas, &foreground);

    encode_jpeg_under_limit(&canvas)
}

fn encode_jpeg_under_limit(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let rgb = DynamicImage::ImageRgba8(image.clone()).to_rgb8();
    for quality in [84_u8, 80, 76, 72, 68, 64, 60] {
        let mut output = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut output, quality);
        encoder
            .encode(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|err| err.to_string())?;
        if output.len() <= MAX_OUTPUT_BYTES || quality == 60 {
            return Ok(output);
        }
    }
    Err("Discord cover image could not be encoded.".to_string())
}

fn select_custom_discord_cover_upload_url(
    runtime_override: Option<String>,
    build_override: Option<&'static str>,
) -> Option<String> {
    [runtime_override, build_override.map(str::to_string)]
        .into_iter()
        .flatten()
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

fn parse_public_https_url(raw: &str, error_prefix: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw).map_err(|_| format!("{error_prefix} is invalid."))?;
    if parsed.scheme() != "https" {
        return Err(format!("{error_prefix} must be HTTPS."));
    }
    validate_before_public_request(&parsed, UrlTrust::PublicHttps)?;
    Ok(parsed)
}

fn discord_cover_upload_target() -> Result<DiscordCoverUploadTarget, String> {
    if let Some(upload_url) = select_custom_discord_cover_upload_url(
        std::env::var(DISCORD_COVER_UPLOAD_URL_ENV).ok(),
        option_env!("EPIGRAPH_DISCORD_COVER_UPLOAD_URL"),
    ) {
        return parse_public_https_url(&upload_url, "Discord cover upload endpoint")
            .map(DiscordCoverUploadTarget::JsonEndpoint);
    }

    parse_public_https_url(UGUU_UPLOAD_URL, "Uguu upload endpoint")
        .map(DiscordCoverUploadTarget::Uguu)
}

fn validate_json_upload_response(
    response: JsonCoverUploadResponse,
    now: u64,
) -> Result<DiscordCoverResponse, String> {
    let parsed = Url::parse(response.url.trim())
        .map_err(|_| "Discord cover upload endpoint returned an invalid URL.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Discord cover upload endpoint returned a non-HTTPS URL.".to_string());
    }
    resolve_public_host(&parsed)?;

    let max_expires_at = now.saturating_add(MAX_UPLOAD_TTL_MS);
    let expires_at = response
        .expires_at
        .filter(|value| *value > now)
        .map(|value| value.min(max_expires_at))
        .unwrap_or(max_expires_at);

    Ok(DiscordCoverResponse {
        url: parsed.to_string(),
        expires_at,
    })
}

fn validate_uguu_response(
    response: UguuUploadResponse,
    now: u64,
) -> Result<DiscordCoverResponse, String> {
    if !response.success {
        return Err("Uguu did not accept the optimized cover.".to_string());
    }
    let url = response
        .files
        .first()
        .map(|file| file.url.trim())
        .filter(|url| !url.is_empty())
        .ok_or_else(|| "Uguu did not return an uploaded cover URL.".to_string())?;
    let parsed = Url::parse(url).map_err(|_| "Uguu returned an invalid cover URL.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Uguu returned a non-HTTPS cover URL.".to_string());
    }
    resolve_public_host(&parsed)?;

    Ok(DiscordCoverResponse {
        url: parsed.to_string(),
        expires_at: now.saturating_add(UGUU_TTL_MS),
    })
}

async fn upload_discord_cover(
    bytes: Vec<u8>,
    target: DiscordCoverUploadTarget,
) -> Result<DiscordCoverResponse, String> {
    if bytes.is_empty() || bytes.len() > MAX_OUTPUT_BYTES {
        return Err("Optimized Discord cover is not a supported size.".to_string());
    }

    let client = build_cover_client(Duration::from_secs(COVER_UPLOAD_TIMEOUT_SECONDS))?;
    match target {
        DiscordCoverUploadTarget::Uguu(upload_url) => {
            let response = client
                .post(upload_url)
                .multipart(build_uguu_upload_form(bytes)?)
                .send()
                .await
                .map_err(|err| err.to_string())?;
            let status = response.status();
            let body = response.text().await.map_err(|err| err.to_string())?;
            if status != StatusCode::OK {
                return Err(format!(
                    "Uguu did not accept the optimized cover: {} {}",
                    status.as_u16(),
                    body.chars().take(160).collect::<String>()
                ));
            }

            let body = serde_json::from_str::<UguuUploadResponse>(&body)
                .map_err(|_| "Uguu returned an invalid upload response.".to_string())?;
            validate_uguu_response(body, current_time_ms())
        }
        DiscordCoverUploadTarget::JsonEndpoint(upload_url) => {
            let response = client
                .post(upload_url)
                .multipart(build_json_upload_form(bytes)?)
                .send()
                .await
                .map_err(|err| err.to_string())?;
            if response.status() != StatusCode::OK {
                return Err(
                    "Discord cover upload endpoint did not accept the optimized cover.".to_string(),
                );
            }

            let body = response
                .json::<JsonCoverUploadResponse>()
                .await
                .map_err(|err| err.to_string())?;
            validate_json_upload_response(body, current_time_ms())
        }
    }
}

fn build_uguu_upload_form(bytes: Vec<u8>) -> Result<multipart::Form, String> {
    let part = multipart::Part::bytes(bytes)
        .file_name("epigraph-discord-cover.jpg")
        .mime_str("image/jpeg")
        .map_err(|err| err.to_string())?;
    Ok(multipart::Form::new().part("files[]", part))
}

fn build_json_upload_form(bytes: Vec<u8>) -> Result<multipart::Form, String> {
    let part = multipart::Part::bytes(bytes)
        .file_name("epigraph-discord-cover.jpg")
        .mime_str("image/jpeg")
        .map_err(|err| err.to_string())?;
    Ok(multipart::Form::new().part("file", part))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgba};

    fn sample_image(width: u32, height: u32) -> Vec<u8> {
        let mut image = RgbaImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = if x < width / 2 {
                Rgba([220, (y % 255) as u8, 70, 255])
            } else {
                Rgba([30, 90, (x % 255) as u8, 255])
            };
        }
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(image)
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }

    #[test]
    fn composes_vertical_cover_to_square_without_distorting_canvas() {
        let output = compose_discord_cover(&sample_image(400, 1200)).unwrap();
        let decoded = image::load_from_memory(&output).unwrap();

        assert_eq!(decoded.dimensions(), (CANVAS_SIZE, CANVAS_SIZE));
        assert!(output.len() <= MAX_OUTPUT_BYTES);
    }

    #[test]
    fn expands_common_vertical_covers_to_reduce_side_borders() {
        let foreground_limit = CANVAS_SIZE.saturating_sub(FOREGROUND_MARGIN * 2);
        let image = DynamicImage::ImageRgba8(RgbaImage::new(700, 1000));
        let foreground = resize_foreground(&image, foreground_limit, foreground_limit);

        assert!(foreground.width() >= FOREGROUND_NARROW_MIN_WIDTH);
        assert_eq!(foreground.height(), CANVAS_SIZE);
    }

    #[test]
    fn composes_horizontal_cover_to_square_without_distorting_canvas() {
        let output = compose_discord_cover(&sample_image(1400, 500)).unwrap();
        let decoded = image::load_from_memory(&output).unwrap();

        assert_eq!(decoded.dimensions(), (CANVAS_SIZE, CANVAS_SIZE));
        assert!(output.len() <= MAX_OUTPUT_BYTES);
    }

    #[test]
    fn rejects_private_public_urls() {
        assert!(validate_source_url("https://127.0.0.1/cover.jpg", None).is_err());
        assert!(validate_source_url("https://192.168.1.2/cover.jpg", None).is_err());
        assert!(validate_source_url("data:image/png;base64,abc", None).is_err());
    }

    #[test]
    fn rejects_public_redirects_to_private_hosts() {
        let redirect =
            validate_redirect_url("https://127.0.0.1/cover.jpg", UrlTrust::PublicHttps, None);
        assert!(redirect.is_err());
    }

    #[test]
    fn allows_only_matching_trusted_local_origin() {
        let allowed = validate_source_url(
            "http://127.0.0.1:4567/api/v1/manga/1/thumbnail",
            Some("http://127.0.0.1:4567"),
        );
        assert!(matches!(allowed, Ok((_, UrlTrust::TrustedLocal))));

        let rejected = validate_source_url(
            "http://127.0.0.1:9999/api/v1/manga/1/thumbnail",
            Some("http://127.0.0.1:4567"),
        );
        assert!(rejected.is_err());
    }

    #[test]
    fn rejects_local_paths_outside_allowed_roots() {
        assert!(read_allowed_local_cover("C:/Windows/not-a-cover.jpg").is_err());
    }

    #[test]
    fn accepts_public_json_upload_response_and_caps_expiration() {
        let now = 1_000;
        let response = validate_json_upload_response(
            JsonCoverUploadResponse {
                url: "https://1.1.1.1/epigraph-cover.jpg".to_string(),
                expires_at: Some(now + MAX_UPLOAD_TTL_MS + 10_000),
            },
            now,
        )
        .unwrap();

        assert_eq!(response.url, "https://1.1.1.1/epigraph-cover.jpg");
        assert_eq!(response.expires_at, now + MAX_UPLOAD_TTL_MS);
    }

    #[test]
    fn rejects_unsafe_upload_response_urls() {
        for url in [
            "http://example.com/epigraph-cover.jpg",
            "https://127.0.0.1/epigraph-cover.jpg",
            "https://192.168.1.2/epigraph-cover.jpg",
        ] {
            let response = validate_json_upload_response(
                JsonCoverUploadResponse {
                    url: url.to_string(),
                    expires_at: None,
                },
                1_000,
            );
            assert!(response.is_err());
        }
    }

    #[test]
    fn selects_runtime_upload_endpoint_before_build_endpoint() {
        let selected = select_custom_discord_cover_upload_url(
            Some(" https://dev.example.com/discord-cover ".to_string()),
            Some("https://build.example.com/discord-cover"),
        );

        assert_eq!(
            selected.as_deref(),
            Some("https://dev.example.com/discord-cover"),
        );
    }

    #[test]
    fn uses_uguu_when_no_custom_upload_endpoint_is_configured() {
        let target = discord_cover_upload_target().unwrap();
        let expected = Url::parse(UGUU_UPLOAD_URL).unwrap();

        assert_eq!(target, DiscordCoverUploadTarget::Uguu(expected));
    }

    #[test]
    fn ignores_empty_upload_endpoint_candidates() {
        let selected = select_custom_discord_cover_upload_url(Some("   ".to_string()), Some(""));

        assert_eq!(selected, None);
    }

    #[test]
    fn accepts_uguu_https_response_with_3h_expiration() {
        let now = 2_000;
        let response = validate_uguu_response(
            UguuUploadResponse {
                success: true,
                files: vec![UguuUploadedFile {
                    url: "https://n.uguu.se/epigraph.jpg".to_string(),
                }],
            },
            now,
        )
        .unwrap();

        assert_eq!(response.url, "https://n.uguu.se/epigraph.jpg");
        assert_eq!(response.expires_at, now + UGUU_TTL_MS);
    }

    #[test]
    fn rejects_images_with_excessive_dimensions() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0x42, 0x4d]);
        bytes.extend_from_slice(&(54_u32).to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(&(54_u32).to_le_bytes());
        bytes.extend_from_slice(&(40_u32).to_le_bytes());
        bytes.extend_from_slice(&(MAX_SOURCE_DIMENSION as i32 + 1).to_le_bytes());
        bytes.extend_from_slice(&(1_i32).to_le_bytes());
        bytes.extend_from_slice(&(1_u16).to_le_bytes());
        bytes.extend_from_slice(&(24_u16).to_le_bytes());
        bytes.extend_from_slice(&[0; 24]);

        assert!(compose_discord_cover(&bytes).is_err());
    }
}
