use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const LOOPBACK_HOST: &str = "127.0.0.1";
#[allow(dead_code)]
pub const TEMPORARY_LAN_BIND_HOST: &str = "0.0.0.0";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryLanExposureSession {
    pub profile_key: String,
    pub bind_host: String,
    pub advertised_host: Option<String>,
    pub started_at_ms: u128,
    pub expires_at_ms: u128,
    pub owner_app_pid: u32,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LanExposureMode {
    LoopbackOnly,
    TemporarySession(TemporaryLanExposureSession),
}

pub fn session_path(data_dir: &Path) -> PathBuf {
    data_dir.join("suwayomi-lan-session.json")
}

pub fn load_and_sanitize(data_dir: &Path, profile_key: &str) -> io::Result<LanExposureMode> {
    let path = session_path(data_dir);
    let session = match read_session(data_dir)? {
        Some(session) => session,
        None => return Ok(LanExposureMode::LoopbackOnly),
    };

    let stale = session.profile_key != profile_key
        || session.expires_at_ms <= now_ms()
        || session.owner_app_pid != std::process::id();
    if stale {
        let _ = fs::remove_file(&path);
        return Ok(LanExposureMode::LoopbackOnly);
    }

    Ok(LanExposureMode::TemporarySession(session))
}

pub fn read_session(data_dir: &Path) -> io::Result<Option<TemporaryLanExposureSession>> {
    let path = session_path(data_dir);
    if !path.exists() {
        return Ok(None);
    }

    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) => {
            let _ = fs::remove_file(&path);
            return Err(err);
        }
    };
    let session = match serde_json::from_str::<TemporaryLanExposureSession>(&raw) {
        Ok(session) => session,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return Ok(None);
        }
    };

    Ok(Some(session))
}

#[allow(dead_code)]
pub fn start_temporary_session(
    data_dir: &Path,
    profile_key: &str,
    ttl: Duration,
    advertised_host: Option<String>,
    reason: impl Into<String>,
) -> io::Result<TemporaryLanExposureSession> {
    fs::create_dir_all(data_dir)?;
    let session = TemporaryLanExposureSession {
        profile_key: profile_key.to_string(),
        bind_host: TEMPORARY_LAN_BIND_HOST.to_string(),
        advertised_host,
        started_at_ms: now_ms(),
        expires_at_ms: now_ms() + ttl.as_millis(),
        owner_app_pid: std::process::id(),
        reason: reason.into(),
    };
    let payload = serde_json::to_vec_pretty(&session)?;
    fs::write(session_path(data_dir), payload)?;
    Ok(session)
}

pub fn clear_temporary_session(data_dir: &Path) -> io::Result<()> {
    let path = session_path(data_dir);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn bind_host_for_mode(mode: &LanExposureMode) -> &str {
    match mode {
        LanExposureMode::LoopbackOnly => LOOPBACK_HOST,
        LanExposureMode::TemporarySession(session) => &session.bind_host,
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn defaults_to_loopback_without_session() {
        let temp = tempdir().unwrap();
        let mode = load_and_sanitize(temp.path(), "main").unwrap();
        assert_eq!(mode, LanExposureMode::LoopbackOnly);
        assert_eq!(bind_host_for_mode(&mode), LOOPBACK_HOST);
    }

    #[test]
    fn keeps_valid_session_for_same_profile_and_process() {
        let temp = tempdir().unwrap();
        let session = start_temporary_session(
            temp.path(),
            "main",
            Duration::from_secs(60),
            Some("192.168.0.10".to_string()),
            "phase-gate",
        )
        .unwrap();

        let mode = load_and_sanitize(temp.path(), "main").unwrap();
        assert_eq!(mode, LanExposureMode::TemporarySession(session));
        assert_eq!(bind_host_for_mode(&mode), TEMPORARY_LAN_BIND_HOST);
    }

    #[test]
    fn clears_expired_session_back_to_loopback() {
        let temp = tempdir().unwrap();
        let path = session_path(temp.path());
        let session = TemporaryLanExposureSession {
            profile_key: "main".to_string(),
            bind_host: TEMPORARY_LAN_BIND_HOST.to_string(),
            advertised_host: None,
            started_at_ms: 1,
            expires_at_ms: 2,
            owner_app_pid: std::process::id(),
            reason: "expired".to_string(),
        };
        fs::write(&path, serde_json::to_vec_pretty(&session).unwrap()).unwrap();

        let mode = load_and_sanitize(temp.path(), "main").unwrap();
        assert_eq!(mode, LanExposureMode::LoopbackOnly);
        assert!(!path.exists());
    }

    #[test]
    fn clears_profile_mismatch_back_to_loopback() {
        let temp = tempdir().unwrap();
        start_temporary_session(
            temp.path(),
            "test",
            Duration::from_secs(60),
            None,
            "phase-gate",
        )
        .unwrap();

        let mode = load_and_sanitize(temp.path(), "main").unwrap();
        assert_eq!(mode, LanExposureMode::LoopbackOnly);
        assert!(!session_path(temp.path()).exists());
    }
}
