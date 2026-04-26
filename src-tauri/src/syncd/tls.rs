use anyhow::Context;
use axum_server::tls_rustls::RustlsConfig;
use rcgen::generate_simple_self_signed;
use rustls::crypto::aws_lc_rs;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

use super::config::SyncdConfig;

#[derive(Clone, Debug)]
pub struct TlsMaterial {
    pub rustls_config: RustlsConfig,
    pub fingerprint_sha256: String,
}

pub async fn load_or_create(config: &SyncdConfig) -> anyhow::Result<TlsMaterial> {
    ensure_crypto_provider();
    std::fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("failed to create tls dir {}", config.data_dir.display()))?;

    if !config.cert_path.exists() || !config.key_path.exists() {
        let mut alt_names = vec!["localhost".to_string(), "127.0.0.1".to_string()];
        let bind_ip = config.bind_addr.ip().to_string();
        if !alt_names.iter().any(|value| value == &bind_ip) {
            alt_names.push(bind_ip);
        }

        let certified = generate_simple_self_signed(alt_names)?;
        std::fs::write(&config.cert_path, certified.cert.pem())
            .with_context(|| format!("failed to write {}", config.cert_path.display()))?;
        std::fs::write(&config.key_path, certified.key_pair.serialize_pem())
            .with_context(|| format!("failed to write {}", config.key_path.display()))?;
    }

    let cert_pem = std::fs::read(&config.cert_path)
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

fn ensure_crypto_provider() {
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
    use tempfile::tempdir;

    use super::*;
    use crate::syncd::config::SyncdConfig;

    #[tokio::test]
    async fn generates_stable_fingerprint_across_reloads() {
        let temp = tempdir().unwrap();
        let config = SyncdConfig::for_test(temp.path().to_path_buf());
        let first = load_or_create(&config).await.unwrap();
        let second = load_or_create(&config).await.unwrap();
        assert_eq!(first.fingerprint_sha256, second.fingerprint_sha256);
        assert_eq!(first.fingerprint_sha256.len(), 64);
    }
}
