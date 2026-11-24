//! Hybrid Logical Clock (HLC) and canonical portable URL/key normalization for Sync V4.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};
use url::Url;

/// Maximum future clock skew tolerated from a client HLC (10 minutes).
pub const MAX_FUTURE_SKEW_MS: i64 = 10 * 60 * 1000;

/// Transient rendering/tracking query parameters stripped from portable chapter/work URLs
/// so source refetches (e.g. `?style=list` on Madara/Toonily) never split chapter identity.
const TRANSIENT_QUERY_PARAMS: &[&str] = &[
    "style",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "fbclid",
    "gclid",
    "ref",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hlc {
    pub ts_ms: i64,
    #[serde(default)]
    pub counter: i64,
    pub device_id: String,
}

impl Hlc {
    pub fn new(ts_ms: i64, counter: i64, device_id: impl Into<String>) -> Self {
        Self {
            ts_ms,
            counter: counter.max(0),
            device_id: device_id.into(),
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.ts_ms <= 0 {
            return Err("hlc.tsMs must be positive");
        }
        if self.counter < 0 {
            return Err("hlc.counter must be non-negative");
        }
        if self.device_id.trim().is_empty() || self.device_id.len() > 128 {
            return Err("hlc.deviceId must be 1..=128 chars");
        }
        Ok(())
    }

    /// Clamps absurd client future timestamps to `server_now_ms + MAX_FUTURE_SKEW_MS` so a phone
    /// with a misconfigured clock cannot permanently freeze an entity's LWW clock.
    pub fn clamp_to_server_now(&self, server_now_ms: i64) -> Self {
        let max_ts = server_now_ms.saturating_add(MAX_FUTURE_SKEW_MS);
        if self.ts_ms > max_ts {
            Self {
                ts_ms: max_ts,
                counter: self.counter,
                device_id: self.device_id.clone(),
            }
        } else {
            self.clone()
        }
    }
}

impl Ord for Hlc {
    fn cmp(&self, other: &Self) -> Ordering {
        self.ts_ms
            .cmp(&other.ts_ms)
            .then_with(|| self.counter.cmp(&other.counter))
            .then_with(|| self.device_id.cmp(&other.device_id))
    }
}

impl PartialOrd for Hlc {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Normalizes a comic/novel work or chapter URL into a host-independent portable path:
/// - Strips scheme and host (`https://toonily.com/webtoon/foo/ch-1/?style=list` -> `/webtoon/foo/ch-1`)
/// - Drops transient query parameters (`style`, `utm_*`, `fbclid`, `gclid`, `ref`)
/// - Sorts remaining significant query parameters deterministically
/// - Collapses repeated slashes and trims trailing `/` (except root `/`)
pub fn normalize_portable_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // Parse full URLs or relative paths via a synthetic base.
    let parsed = Url::parse(trimmed)
        .or_else(|_| {
            let prefixed = if trimmed.starts_with('/') {
                format!("https://epigraph.invalid{trimmed}")
            } else {
                format!("https://epigraph.invalid/{trimmed}")
            };
            Url::parse(&prefixed)
        })
        .ok();

    let Some(url) = parsed else {
        return normalize_path_segments(trimmed);
    };

    let path = normalize_path_segments(url.path());
    let mut kept_params: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| {
            let lower = key.to_ascii_lowercase();
            !TRANSIENT_QUERY_PARAMS.iter().any(|drop| *drop == lower)
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    if kept_params.is_empty() {
        return path;
    }

    kept_params.sort();
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in kept_params {
        serializer.append_pair(&k, &v);
    }
    let query = serializer.finish();
    format!("{path}?{query}")
}

fn normalize_path_segments(raw_path: &str) -> String {
    let without_fragment = raw_path.split('#').next().unwrap_or(raw_path);
    let mut out = String::with_capacity(without_fragment.len() + 1);
    let mut prev_slash = false;
    for ch in without_fragment.chars() {
        if ch == '/' {
            if !prev_slash {
                out.push('/');
                prev_slash = true;
            }
        } else {
            out.push(ch);
            prev_slash = false;
        }
    }
    if !out.starts_with('/') {
        out.insert(0, '/');
    }
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
}

/// Builds a canonical portable work key (`<source_or_plugin_id>:<normalized_url>`).
pub fn canonical_work_key(source_or_plugin_id: &str, raw_url: &str) -> String {
    format!(
        "{}:{}",
        source_or_plugin_id.trim(),
        normalize_portable_url(raw_url)
    )
}

/// Builds a canonical portable chapter key (`<work_key>|<normalized_chapter_url>`).
pub fn canonical_chapter_key(work_key: &str, raw_chapter_url: &str) -> String {
    format!(
        "{}|{}",
        work_key.trim(),
        normalize_portable_url(raw_chapter_url)
    )
}
