use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

#[cfg(test)]
use std::collections::BTreeMap;
#[cfg(test)]
use std::sync::{Arc, RwLock};

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use url::Url;

const DEFAULT_PORT: u16 = 4777;
const DEFAULT_DISCOVERY_MDNS_PORT: u16 = 5353;
const DEFAULT_PROTOCOL_VERSION: u32 = 1;
// Keep the first mobile prerelease accepted by the Core.  A stable 0.1.0
// client still compares newer than this floor, while development APKs retain
// their truthful semantic version instead of pretending to be a release.
const DEFAULT_MIN_CLIENT_VERSION: &str = "0.1.0-alpha.1";
const DEFAULT_MDNS_SERVICE_NAME: &str = "_epigraph-sync._tcp.local.";
const DEFAULT_ASSET_MAX_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncdOwnershipMode {
    EphemeralOwned,
    PersistentAttached,
}

impl SyncdOwnershipMode {
    #[allow(dead_code)]
    pub fn as_env_value(self) -> &'static str {
        match self {
            Self::EphemeralOwned => "ephemeral-owned",
            Self::PersistentAttached => "persistent-attached",
        }
    }

    fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "ephemeral-owned" => Ok(Self::EphemeralOwned),
            "persistent-attached" => Ok(Self::PersistentAttached),
            other => bail!("unsupported syncd ownership mode '{other}'"),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SyncdDiscoveryProviderMode {
    Disabled,
    LanPublication,
}

impl SyncdDiscoveryProviderMode {
    fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "disabled" => Ok(Self::Disabled),
            "lan-publication" => Ok(Self::LanPublication),
            other => bail!("unsupported discovery provider mode '{other}'"),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SyncdManualDiscoveryProviderMode {
    Disabled,
    Enabled,
}

impl SyncdManualDiscoveryProviderMode {
    fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "disabled" => Ok(Self::Disabled),
            "enabled" => Ok(Self::Enabled),
            other => bail!("unsupported manual discovery provider mode '{other}'"),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SyncdEffectiveDiscoveryPolicy {
    AdvertisedOnly,
    ManualPreferred,
}

impl SyncdEffectiveDiscoveryPolicy {
    fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "advertised-only" => Ok(Self::AdvertisedOnly),
            "manual-preferred" | "manual-if-valid-else-advertised" => Ok(Self::ManualPreferred),
            other => bail!("unsupported effective discovery policy '{other}'"),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::AdvertisedOnly => "advertised-only",
            Self::ManualPreferred => "manual-preferred",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncdAdvertisedEndpoint {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

impl SyncdAdvertisedEndpoint {
    pub fn base_url(&self) -> String {
        let host = if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("{}://{}:{}", self.scheme, host, self.port)
    }

    fn from_socket_addr(addr: SocketAddr) -> Self {
        Self {
            scheme: "https".to_string(),
            host: addr.ip().to_string(),
            port: addr.port(),
        }
    }

    pub(crate) fn parse(raw: &str) -> anyhow::Result<Self> {
        let url = Url::parse(raw)
            .with_context(|| format!("failed to parse advertised endpoint '{raw}' as a URL"))?;

        if url.scheme() != "https" {
            bail!("advertised endpoint '{raw}' must use https");
        }
        if url.query().is_some() || url.fragment().is_some() {
            bail!("advertised endpoint '{raw}' must not include query or fragment");
        }
        if url.path() != "/" && !url.path().is_empty() {
            bail!("advertised endpoint '{raw}' must not include a path");
        }

        let host = url
            .host_str()
            .ok_or_else(|| anyhow!("advertised endpoint '{raw}' is missing a host"))?
            .to_string();
        let port = url
            .port_or_known_default()
            .ok_or_else(|| anyhow!("advertised endpoint '{raw}' is missing a port"))?;

        Ok(Self {
            scheme: "https".to_string(),
            host,
            port,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncdAdvertisedEndpointPolicy {
    AutoBind,
    Override(SyncdAdvertisedEndpoint),
    Candidates(Vec<SyncdAdvertisedEndpoint>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncdAdvertisedEndpointResolution {
    pub selected: SyncdAdvertisedEndpoint,
    pub candidates: Vec<SyncdAdvertisedEndpoint>,
    pub policy_name: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncdAdvertisedEndpointResolver {
    policy: SyncdAdvertisedEndpointPolicy,
}

impl SyncdAdvertisedEndpointResolver {
    pub fn from_config(config: &SyncdConfig) -> anyhow::Result<Self> {
        let policy = if let Some(raw) = config.advertised_base_url.as_deref() {
            SyncdAdvertisedEndpointPolicy::Override(SyncdAdvertisedEndpoint::parse(raw)?)
        } else if !config.advertised_candidates.is_empty() {
            let candidates = config
                .advertised_candidates
                .iter()
                .map(|raw| SyncdAdvertisedEndpoint::parse(raw))
                .collect::<anyhow::Result<Vec<_>>>()?;
            if candidates.is_empty() {
                bail!("advertised endpoint candidate list must not be empty");
            }
            SyncdAdvertisedEndpointPolicy::Candidates(candidates)
        } else {
            SyncdAdvertisedEndpointPolicy::AutoBind
        };

        Ok(Self { policy })
    }

    pub fn resolve(&self, bind_addr: SocketAddr) -> SyncdAdvertisedEndpointResolution {
        match &self.policy {
            SyncdAdvertisedEndpointPolicy::AutoBind => {
                let selected = SyncdAdvertisedEndpoint::from_socket_addr(bind_addr);
                SyncdAdvertisedEndpointResolution {
                    selected: selected.clone(),
                    candidates: vec![selected],
                    policy_name: "auto_bind",
                }
            }
            SyncdAdvertisedEndpointPolicy::Override(endpoint) => {
                SyncdAdvertisedEndpointResolution {
                    selected: endpoint.clone(),
                    candidates: vec![endpoint.clone()],
                    policy_name: "override",
                }
            }
            SyncdAdvertisedEndpointPolicy::Candidates(candidates) => {
                let selected = candidates
                    .first()
                    .cloned()
                    .expect("validated non-empty candidates");
                SyncdAdvertisedEndpointResolution {
                    selected,
                    candidates: candidates.clone(),
                    policy_name: "candidates",
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct SyncdConfig {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
    pub bind_addr: SocketAddr,
    pub min_client_version: String,
    pub server_protocol_version: u32,
    pub mdns_service_name: String,
    pub discovery_mdns_port: u16,
    pub discovery_provider_mode: SyncdDiscoveryProviderMode,
    pub manual_discovery_provider_mode: SyncdManualDiscoveryProviderMode,
    pub manual_discovery_origins: Vec<String>,
    pub effective_discovery_policy: SyncdEffectiveDiscoveryPolicy,
    pub advertised_base_url: Option<String>,
    pub advertised_candidates: Vec<String>,
    pub ping_interval: Duration,
    #[allow(dead_code)]
    pub retention_window: Duration,
    pub bootstrap_session_window: Duration,
    pub token_inactivity_window: Duration,
    pub asset_max_upload_bytes: u64,
    pub ownership_mode: SyncdOwnershipMode,
    pub parent_pid: Option<u32>,
    #[cfg(test)]
    pub suwayomi_proxy_test_upstreams: Arc<RwLock<BTreeMap<String, String>>>,
}

impl SyncdConfig {
    pub fn from_env() -> Self {
        let data_dir = std::env::var_os("EPIGRAPH_SYNCD_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(default_data_dir);
        let db_path = data_dir.join("syncd.sqlite");
        let cert_path = data_dir.join("cert.pem");
        let key_path = data_dir.join("key.pem");

        let bind_ip = std::env::var("EPIGRAPH_SYNCD_BIND_HOST")
            .ok()
            .and_then(|raw| raw.parse::<IpAddr>().ok())
            .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
        let port = std::env::var("EPIGRAPH_SYNCD_PORT")
            .ok()
            .and_then(|raw| raw.parse::<u16>().ok())
            .unwrap_or(DEFAULT_PORT);
        let discovery_provider_mode = std::env::var("EPIGRAPH_SYNCD_DISCOVERY_PROVIDER")
            .ok()
            .map(|raw| SyncdDiscoveryProviderMode::parse(&raw))
            .transpose()
            .unwrap_or_else(|error| panic!("invalid EPIGRAPH_SYNCD_DISCOVERY_PROVIDER: {error}"))
            .unwrap_or(SyncdDiscoveryProviderMode::LanPublication);
        let manual_discovery_provider_mode = std::env::var("EPIGRAPH_SYNCD_MANUAL_PROVIDER")
            .ok()
            .map(|raw| SyncdManualDiscoveryProviderMode::parse(&raw))
            .transpose()
            .unwrap_or_else(|error| panic!("invalid EPIGRAPH_SYNCD_MANUAL_PROVIDER: {error}"))
            .unwrap_or(SyncdManualDiscoveryProviderMode::Disabled);
        let discovery_mdns_port = std::env::var("EPIGRAPH_SYNCD_DISCOVERY_MDNS_PORT")
            .ok()
            .and_then(|raw| raw.parse::<u16>().ok())
            .unwrap_or(DEFAULT_DISCOVERY_MDNS_PORT);
        let manual_discovery_origins = std::env::var("EPIGRAPH_SYNCD_MANUAL_ORIGINS")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let effective_discovery_policy = std::env::var("EPIGRAPH_SYNCD_EFFECTIVE_DISCOVERY_POLICY")
            .ok()
            .map(|raw| SyncdEffectiveDiscoveryPolicy::parse(&raw))
            .transpose()
            .unwrap_or_else(|error| {
                panic!("invalid EPIGRAPH_SYNCD_EFFECTIVE_DISCOVERY_POLICY: {error}")
            })
            .unwrap_or(SyncdEffectiveDiscoveryPolicy::AdvertisedOnly);
        let advertised_base_url = std::env::var("EPIGRAPH_SYNCD_ADVERTISED_BASE_URL")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty());
        let advertised_candidates = std::env::var("EPIGRAPH_SYNCD_ADVERTISED_CANDIDATES")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let parent_pid = std::env::var("EPIGRAPH_SYNCD_PARENT_PID")
            .ok()
            .and_then(|raw| raw.parse::<u32>().ok());
        let ownership_mode = std::env::var("EPIGRAPH_SYNCD_OWNERSHIP")
            .ok()
            .map(|raw| SyncdOwnershipMode::parse(&raw))
            .transpose()
            .unwrap_or_else(|error| panic!("invalid EPIGRAPH_SYNCD_OWNERSHIP: {error}"))
            .unwrap_or_else(|| {
                if parent_pid.is_some() {
                    SyncdOwnershipMode::EphemeralOwned
                } else {
                    SyncdOwnershipMode::PersistentAttached
                }
            });

        Self {
            data_dir,
            db_path,
            cert_path,
            key_path,
            bind_addr: SocketAddr::new(bind_ip, port),
            min_client_version: std::env::var("EPIGRAPH_SYNCD_MIN_CLIENT_VERSION")
                .unwrap_or_else(|_| DEFAULT_MIN_CLIENT_VERSION.to_string()),
            server_protocol_version: std::env::var("EPIGRAPH_SYNCD_PROTOCOL_VERSION")
                .ok()
                .and_then(|raw| raw.parse::<u32>().ok())
                .unwrap_or(DEFAULT_PROTOCOL_VERSION),
            mdns_service_name: std::env::var("EPIGRAPH_SYNCD_MDNS_SERVICE_NAME")
                .ok()
                .map(|raw| raw.trim().to_string())
                .filter(|raw| !raw.is_empty())
                .unwrap_or_else(|| DEFAULT_MDNS_SERVICE_NAME.to_string()),
            discovery_mdns_port,
            discovery_provider_mode,
            manual_discovery_provider_mode,
            manual_discovery_origins,
            effective_discovery_policy,
            advertised_base_url,
            advertised_candidates,
            ping_interval: Duration::from_secs(30),
            retention_window: Duration::from_secs(30 * 24 * 60 * 60),
            bootstrap_session_window: Duration::from_secs(
                std::env::var("EPIGRAPH_SYNCD_BOOTSTRAP_TTL_SECONDS")
                    .ok()
                    .and_then(|raw| raw.parse::<u64>().ok())
                    .unwrap_or(120),
            ),
            token_inactivity_window: Duration::from_secs(30 * 24 * 60 * 60),
            asset_max_upload_bytes: std::env::var("EPIGRAPH_SYNCD_ASSET_MAX_BYTES")
                .ok()
                .map(|raw| {
                    raw.parse::<u64>()
                        .ok()
                        .filter(|value| *value > 0)
                        .unwrap_or_else(|| {
                            panic!("EPIGRAPH_SYNCD_ASSET_MAX_BYTES must be a positive integer")
                        })
                })
                .unwrap_or(DEFAULT_ASSET_MAX_UPLOAD_BYTES),
            ownership_mode,
            parent_pid,
            #[cfg(test)]
            suwayomi_proxy_test_upstreams: Arc::new(RwLock::new(BTreeMap::new())),
        }
    }

    #[cfg(test)]
    pub fn for_test(base_dir: PathBuf) -> Self {
        let db_path = base_dir.join("syncd.sqlite");
        let cert_path = base_dir.join("cert.pem");
        let key_path = base_dir.join("key.pem");
        Self {
            data_dir: base_dir,
            db_path,
            cert_path,
            key_path,
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), DEFAULT_PORT),
            min_client_version: DEFAULT_MIN_CLIENT_VERSION.to_string(),
            server_protocol_version: DEFAULT_PROTOCOL_VERSION,
            mdns_service_name: DEFAULT_MDNS_SERVICE_NAME.to_string(),
            discovery_mdns_port: 5454,
            discovery_provider_mode: SyncdDiscoveryProviderMode::LanPublication,
            manual_discovery_provider_mode: SyncdManualDiscoveryProviderMode::Disabled,
            manual_discovery_origins: Vec::new(),
            effective_discovery_policy: SyncdEffectiveDiscoveryPolicy::AdvertisedOnly,
            advertised_base_url: None,
            advertised_candidates: Vec::new(),
            ping_interval: Duration::from_millis(25),
            retention_window: Duration::from_secs(30 * 24 * 60 * 60),
            bootstrap_session_window: Duration::from_secs(120),
            token_inactivity_window: Duration::from_secs(30 * 24 * 60 * 60),
            asset_max_upload_bytes: DEFAULT_ASSET_MAX_UPLOAD_BYTES,
            ownership_mode: SyncdOwnershipMode::PersistentAttached,
            parent_pid: None,
            suwayomi_proxy_test_upstreams: Arc::new(RwLock::new(BTreeMap::new())),
        }
    }

    #[cfg(test)]
    pub fn set_suwayomi_proxy_test_upstream(&self, profile_id: &str, base_url: &str) {
        self.suwayomi_proxy_test_upstreams
            .write()
            .expect("test Suwayomi upstream registry poisoned")
            .insert(profile_id.to_string(), base_url.to_string());
    }
}

fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")))
            .join("Epigraph")
            .join("syncd")
    }

    #[cfg(not(target_os = "windows"))]
    {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("epigraph")
            .join("syncd")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertised_endpoint_defaults_to_bind_resolution() {
        let config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-test"));
        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let resolution = resolver.resolve(config.bind_addr);

        assert_eq!(resolution.policy_name, "auto_bind");
        assert_eq!(resolution.selected.base_url(), "https://127.0.0.1:4777");
        assert_eq!(resolution.candidates.len(), 1);
    }

    #[test]
    fn default_minimum_accepts_mobile_prerelease_floor() {
        let config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-test"));
        assert_eq!(config.min_client_version, "0.1.0-alpha.1");
    }

    #[test]
    fn advertised_endpoint_uses_override_when_configured() {
        let mut config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-test"));
        config.advertised_base_url = Some("https://localhost:9443".to_string());

        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let resolution = resolver.resolve(config.bind_addr);

        assert_eq!(resolution.policy_name, "override");
        assert_eq!(resolution.selected.base_url(), "https://localhost:9443");
    }

    #[test]
    fn advertised_endpoint_rejects_invalid_override() {
        let mut config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-test"));
        config.advertised_base_url = Some("http://localhost:4777/path".to_string());

        let error = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap_err();
        assert!(error.to_string().contains("must use https"));
    }

    #[test]
    fn advertised_endpoint_uses_candidates_when_configured() {
        let mut config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-test"));
        config.advertised_candidates = vec![
            "https://localhost:4777".to_string(),
            "https://127.0.0.1:4777".to_string(),
        ];

        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let resolution = resolver.resolve(config.bind_addr);

        assert_eq!(resolution.policy_name, "candidates");
        assert_eq!(resolution.selected.base_url(), "https://localhost:4777");
        assert_eq!(resolution.candidates.len(), 2);
    }

    #[test]
    fn discovery_provider_mode_defaults_to_lan_publication_in_test_config() {
        let config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-test"));
        assert_eq!(
            config.discovery_provider_mode,
            SyncdDiscoveryProviderMode::LanPublication
        );
    }

    #[test]
    fn discovery_provider_mode_rejects_invalid_value() {
        let error = SyncdDiscoveryProviderMode::parse("bogus").unwrap_err();
        assert!(error
            .to_string()
            .contains("unsupported discovery provider mode"));
    }

    #[test]
    fn manual_discovery_provider_mode_rejects_invalid_value() {
        let error = SyncdManualDiscoveryProviderMode::parse("bogus").unwrap_err();
        assert!(error
            .to_string()
            .contains("unsupported manual discovery provider mode"));
    }

    #[test]
    fn effective_discovery_policy_defaults_to_advertised_only_in_test_config() {
        let config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-test"));
        assert_eq!(
            config.effective_discovery_policy,
            SyncdEffectiveDiscoveryPolicy::AdvertisedOnly
        );
    }

    #[test]
    fn effective_discovery_policy_rejects_invalid_value() {
        let error = SyncdEffectiveDiscoveryPolicy::parse("bogus").unwrap_err();
        assert!(error
            .to_string()
            .contains("unsupported effective discovery policy"));
    }

    #[test]
    fn ownership_mode_has_stable_environment_values() {
        assert_eq!(
            SyncdOwnershipMode::EphemeralOwned.as_env_value(),
            "ephemeral-owned"
        );
        assert_eq!(
            SyncdOwnershipMode::PersistentAttached.as_env_value(),
            "persistent-attached"
        );
        assert_eq!(
            SyncdOwnershipMode::parse("ephemeral-owned").unwrap(),
            SyncdOwnershipMode::EphemeralOwned
        );
        assert!(SyncdOwnershipMode::parse("host").is_err());
    }
}
