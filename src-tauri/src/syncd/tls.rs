use anyhow::Context;
use axum_server::tls_rustls::RustlsConfig;
use rcgen::{generate_simple_self_signed, CertificateParams, SanType};
use rustls::crypto::aws_lc_rs;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};
use url::Url;
use uuid::Uuid;

use super::config::{SyncdAdvertisedEndpoint, SyncdConfig};

const LOOPBACK_DNS_NAME: &str = "localhost";
const LOOPBACK_IP: &str = "127.0.0.1";
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub struct TlsMaterial {
    pub rustls_config: RustlsConfig,
    pub fingerprint_sha256: String,
}

/// Load the Core certificate without rotating an existing identity.
///
/// Hostname verification remains enabled on the clients. A new certificate is
/// generated from the effective discovery policy, while an existing
/// certificate is preserved so mobile clients that pin its fingerprint do not
/// lose their trust relationship after a discovery change.
pub async fn load_or_create(
    config: &SyncdConfig,
    advertised_endpoints: &[SyncdAdvertisedEndpoint],
) -> anyhow::Result<TlsMaterial> {
    ensure_crypto_provider();
    fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("failed to create tls dir {}", config.data_dir.display()))?;

    recover_pending_pair(config).await?;

    let required_alt_names = required_alt_names(config, advertised_endpoints);
    let has_cert = config.cert_path.exists();
    let has_key = config.key_path.exists();
    if has_cert != has_key {
        anyhow::bail!(
            "TLS certificate/key pair is incomplete at {} and {}; refusing to replace persisted identity",
            config.cert_path.display(),
            config.key_path.display()
        );
    }

    if !has_cert {
        let certified = generate_simple_self_signed(required_alt_names.clone())?;
        write_certificate_pair_atomic(
            &config.cert_path,
            &config.key_path,
            certified.cert.pem().as_bytes(),
            certified.key_pair.serialize_pem().as_bytes(),
        )
        .with_context(|| {
            format!(
                "failed to materialize TLS certificate/key pair for advertised hosts {:?}",
                required_alt_names
            )
        })?;
    } else {
        let cert_pem = fs::read(&config.cert_path)
            .with_context(|| format!("failed to read {}", config.cert_path.display()))?;
        let sans = certificate_sans(&cert_pem).with_context(|| {
            format!(
                "failed to inspect existing TLS certificate {}; refusing to replace persisted identity",
                config.cert_path.display()
            )
        })?;
        if !certificate_covers(&sans, &required_alt_names) {
            tracing::warn!(
                required_host_count = required_alt_names.len(),
                "existing Syncd TLS certificate does not cover every advertised endpoint; preserving its fingerprint and requiring explicit certificate repair"
            );
        }
    }

    let cert_pem = fs::read(&config.cert_path)
        .with_context(|| format!("failed to read {}", config.cert_path.display()))?;
    let fingerprint_sha256 = fingerprint_from_pem(&cert_pem)?;
    let rustls_config = RustlsConfig::from_pem_file(&config.cert_path, &config.key_path)
        .await
        .context("failed to load rustls config from generated certificate")?;

    Ok(TlsMaterial {
        rustls_config,
        fingerprint_sha256,
    })
}

/// Return the deterministic set of DNS/IP identities that must be present in
/// the Core certificate.  Loopback is retained for the desktop's local
/// control path; discovery candidates cover LAN and manually configured DNS
/// endpoints.  Unspecified bind addresses are deliberately excluded because
/// they are not valid peer identities.
fn required_alt_names(
    config: &SyncdConfig,
    advertised_endpoints: &[SyncdAdvertisedEndpoint],
) -> Vec<String> {
    let mut names = Vec::new();
    push_host(&mut names, LOOPBACK_DNS_NAME);
    push_host(&mut names, LOOPBACK_IP);

    if !config.bind_addr.ip().is_unspecified() {
        push_host(&mut names, &config.bind_addr.ip().to_string());
    }
    for endpoint in advertised_endpoints {
        push_host(&mut names, &endpoint.host);
    }
    // Manual discovery origins are fallback candidates in both discovery
    // policies.  Include their hosts when they are syntactically usable;
    // discovery retains responsibility for reporting malformed origins.
    for raw_origin in &config.manual_discovery_origins {
        if let Ok(url) = Url::parse(raw_origin) {
            if let Some(host) = url.host_str() {
                push_host(&mut names, host);
            }
        }
    }
    names
}

fn push_host(names: &mut Vec<String>, host: &str) {
    let Some(host) = canonical_host(host) else {
        return;
    };
    if !names.iter().any(|existing| existing == &host) {
        names.push(host);
    }
}

fn canonical_host(host: &str) -> Option<String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return (!ip.is_unspecified()).then(|| ip.to_string());
    }

    let dns = host.trim_end_matches('.').to_ascii_lowercase();
    (!dns.is_empty()).then_some(dns)
}

fn certificate_sans(cert_pem: &[u8]) -> anyhow::Result<Vec<SanType>> {
    let pem_text = std::str::from_utf8(cert_pem).context("TLS certificate is not UTF-8 PEM")?;
    let params = CertificateParams::from_ca_cert_pem(pem_text)
        .map_err(|error| anyhow::anyhow!("X.509 SAN parse failed: {error}"))?;
    Ok(params.subject_alt_names)
}

fn certificate_covers(sans: &[SanType], required_hosts: &[String]) -> bool {
    required_hosts.iter().all(|host| {
        if let Ok(required_ip) = host.parse::<IpAddr>() {
            return sans
                .iter()
                .any(|san| matches!(san, SanType::IpAddress(cert_ip) if *cert_ip == required_ip));
        }

        let required_dns = host.trim_end_matches('.');
        sans.iter().any(|san| {
            matches!(san, SanType::DnsName(cert_dns)
                if cert_dns.as_str().trim_end_matches('.').eq_ignore_ascii_case(required_dns))
        })
    })
}

fn write_certificate_pair_atomic(
    cert_path: &Path,
    key_path: &Path,
    cert_pem: &[u8],
    key_pem: &[u8],
) -> std::io::Result<()> {
    let parent = cert_path
        .parent()
        .or_else(|| key_path.parent())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    if cert_path.exists() || key_path.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "refusing to replace an existing TLS identity during first-time materialization",
        ));
    }

    let pending_path = pending_pair_path(cert_path);
    stage_file(&pending_path, b"pending")?;
    let cert_temp = temporary_path(cert_path, "cert");
    let key_temp = temporary_path(key_path, "key");

    let result = (|| {
        stage_file(&cert_temp, cert_pem)?;
        stage_file(&key_temp, key_pem)?;
        replace_file(&cert_temp, cert_path)?;
        replace_file(&key_temp, key_path)?;
        remove_file_if_present(&pending_path)?;
        Ok(())
    })();

    if let Err(error) = result {
        let _ = fs::remove_file(&cert_temp);
        let _ = fs::remove_file(&key_temp);
        return Err(error);
    }

    Ok(())
}

fn pending_pair_path(cert_path: &Path) -> PathBuf {
    cert_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(".tls-pair.pending")
}

fn remove_file_if_present(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn recover_pending_pair(config: &SyncdConfig) -> anyhow::Result<()> {
    let pending_path = pending_pair_path(&config.cert_path);
    if !pending_path.exists() {
        return Ok(());
    }

    // A pending marker is only written before first-time materialization. A
    // complete pair means the process reached the final write before it was
    // interrupted; an incomplete pair is safe to discard and regenerate.
    let has_cert = config.cert_path.exists();
    let has_key = config.key_path.exists();
    if has_cert && has_key {
        if RustlsConfig::from_pem_file(&config.cert_path, &config.key_path)
            .await
            .is_ok()
        {
            remove_file_if_present(&pending_path)?;
            return Ok(());
        }
    }

    remove_file_if_present(&config.cert_path)?;
    remove_file_if_present(&config.key_path)?;
    remove_file_if_present(&pending_path)?;
    Ok(())
}

fn stage_file(path: &Path, payload: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(payload)?;
    file.sync_all()?;
    drop(file);
    Ok(())
}

fn temporary_path(path: &Path, kind: &str) -> PathBuf {
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("tls");
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(
        ".{file_name}.{kind}.{}.{sequence}-{}.tmp",
        std::process::id(),
        Uuid::new_v4()
    ))
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

pub(crate) fn ensure_crypto_provider() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    INSTALLED.get_or_init(|| {
        let _ = aws_lc_rs::default_provider().install_default();
    });
}

fn fingerprint_from_pem(cert_pem: &[u8]) -> anyhow::Result<String> {
    let blocks = pem::parse_many(cert_pem)?;
    let first = blocks
        .first()
        .ok_or_else(|| anyhow::anyhow!("certificate file did not contain a PEM block"))?;
    let digest = Sha256::digest(first.contents());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    use tempfile::tempdir;

    use super::*;
    use crate::syncd::config::{SyncdAdvertisedEndpoint, SyncdConfig};

    fn endpoint(host: &str) -> SyncdAdvertisedEndpoint {
        SyncdAdvertisedEndpoint {
            scheme: "https".to_string(),
            host: host.to_string(),
            port: 4777,
        }
    }

    #[tokio::test]
    async fn generates_certificate_with_advertised_lan_host() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let endpoints = vec![endpoint("192.168.15.3")];

        load_or_create(&config, &endpoints).await.unwrap();

        let cert_pem = fs::read(&config.cert_path).unwrap();
        let sans = certificate_sans(&cert_pem).unwrap();
        assert!(certificate_covers(
            &sans,
            &required_alt_names(&config, &endpoints)
        ));
        assert!(certificate_covers(&sans, &["192.168.15.3".to_string()]));
    }

    #[tokio::test]
    async fn preserves_fingerprint_when_advertised_host_is_missing() {
        let temp = tempdir().unwrap();
        let mut config = SyncdConfig::for_test(temp.path().to_path_buf());
        config.bind_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4777);

        let first = load_or_create(&config, &[]).await.unwrap();
        let second = load_or_create(&config, &[endpoint("192.168.15.3")])
            .await
            .unwrap();

        assert_eq!(first.fingerprint_sha256, second.fingerprint_sha256);
        let sans = certificate_sans(&fs::read(&config.cert_path).unwrap()).unwrap();
        assert!(!certificate_covers(&sans, &["192.168.15.3".to_string()]));
    }

    #[tokio::test]
    async fn keeps_fingerprint_when_certificate_already_covers_endpoints() {
        let temp = tempdir().unwrap();
        let mut config = SyncdConfig::for_test(temp.path().to_path_buf());
        config.manual_discovery_origins = vec!["https://fallback.syncd.local:9443".to_string()];
        let endpoints = vec![endpoint("syncd.local")];

        let first = load_or_create(&config, &endpoints).await.unwrap();
        let second = load_or_create(&config, &endpoints).await.unwrap();

        assert_eq!(first.fingerprint_sha256, second.fingerprint_sha256);
        let sans = certificate_sans(&fs::read(&config.cert_path).unwrap()).unwrap();
        assert!(certificate_covers(
            &sans,
            &["fallback.syncd.local".to_string()]
        ));
    }

    #[tokio::test]
    async fn generates_stable_fingerprint_across_reloads() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let first = load_or_create(&config, &[]).await.unwrap();
        let second = load_or_create(&config, &[]).await.unwrap();
        assert_eq!(first.fingerprint_sha256, second.fingerprint_sha256);
        assert_eq!(first.fingerprint_sha256.len(), 64);
    }

    #[tokio::test]
    async fn recovers_incomplete_first_materialization() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let pending_path = pending_pair_path(&config.cert_path);

        fs::write(&pending_path, b"pending").unwrap();
        fs::write(&config.cert_path, b"partial certificate").unwrap();

        let material = load_or_create(&config, &[]).await.unwrap();

        assert_eq!(material.fingerprint_sha256.len(), 64);
        assert!(config.cert_path.exists());
        assert!(config.key_path.exists());
        assert!(!pending_path.exists());
        assert!(
            RustlsConfig::from_pem_file(&config.cert_path, &config.key_path)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn rejects_existing_certificate_and_key_that_do_not_match() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let first = load_or_create(&config, &[]).await.unwrap();
        let original_cert = fs::read(&config.cert_path).unwrap();
        let other = generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        fs::write(&config.key_path, other.key_pair.serialize_pem()).unwrap();

        let error = load_or_create(&config, &[]).await.unwrap_err();

        assert!(error.to_string().contains("failed to load rustls config"));
        assert_eq!(fs::read(&config.cert_path).unwrap(), original_cert);
        assert_eq!(first.fingerprint_sha256.len(), 64);
    }
}
