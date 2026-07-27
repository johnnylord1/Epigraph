use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeLifecycleState {
    #[default]
    Unavailable,
    Starting,
    Ready,
    Maintenance,
    Updating,
    Recovering,
    Incompatible,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: RuntimeLifecycleState,
    pub profile_id: Option<String>,
    pub server_url: Option<String>,
    pub pid: Option<u32>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcessIdentity {
    pub pid: u32,
    pub process_creation_time: Option<u64>,
    pub executable_path: Option<String>,
    pub command_line_hash: Option<String>,
}

pub fn command_line_hash(args: &[String]) -> String {
    let mut hasher = Sha256::new();
    for arg in args {
        hasher.update(arg.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

pub fn sanitize_log_line(line: &str, private_paths: &[&Path]) -> String {
    let mut sanitized = line.replace(['\r', '\n'], " ");
    for path in private_paths {
        let path = path.to_string_lossy();
        if !path.is_empty() {
            sanitized = sanitized.replace(path.as_ref(), "<private-path>");
        }
    }

    for key in [
        "authorization",
        "cookie",
        "token",
        "password",
        "apiKey",
        "api-key",
    ] {
        let key_lower = key.to_ascii_lowercase();
        let mut search_from = 0;
        while let Some(relative) = sanitized[search_from..]
            .to_ascii_lowercase()
            .find(&key_lower)
        {
            let start = search_from + relative;
            let Some(equal) = sanitized[start..].find('=') else {
                break;
            };
            let value_start = start + equal + 1;
            let value_end = sanitized[value_start..]
                .find(|character: char| {
                    character.is_whitespace() || character == ',' || character == ';'
                })
                .map(|end| value_start + end)
                .unwrap_or(sanitized.len());
            sanitized.replace_range(value_start..value_end, "<redacted>");
            search_from = value_start + "<redacted>".len();
        }
    }
    sanitized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_hash_is_deterministic_and_ordered() {
        let first = command_line_hash(&["-jar".into(), "server.jar".into()]);
        let second = command_line_hash(&["-jar".into(), "server.jar".into()]);
        let reordered = command_line_hash(&["server.jar".into(), "-jar".into()]);
        assert_eq!(first, second);
        assert_ne!(first, reordered);
    }

    #[test]
    fn logs_redact_private_paths_and_credentials() {
        let path = Path::new("C:\\Users\\test\\AppData");
        let line = "root=C:\\Users\\test\\AppData token=secret cookie=abc123";
        let sanitized = sanitize_log_line(line, &[path]);
        assert!(!sanitized.contains("AppData"));
        assert!(!sanitized.contains("secret"));
        assert!(!sanitized.contains("abc123"));
        assert!(sanitized.contains("<redacted>"));
    }
}
