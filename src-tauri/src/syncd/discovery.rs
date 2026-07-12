use anyhow::{bail, Context};
use mdns_sd::{DaemonEvent, Receiver, ServiceDaemon, ServiceInfo};
use tokio::task::JoinHandle;
use url::Url;

use super::config::{
    SyncdAdvertisedEndpoint, SyncdAdvertisedEndpointResolver, SyncdConfig,
    SyncdDiscoveryProviderMode, SyncdEffectiveDiscoveryPolicy, SyncdManualDiscoveryProviderMode,
};
use super::db::ServerIdentityRow;
use super::models::{
    SharedAppState, SyncdClientDiscoveryAttemptGuidance, SyncdClientDiscoveryBehaviorGuidance,
    SyncdClientDiscoveryCandidate, SyncdClientDiscoveryCapabilities, SyncdClientDiscoveryContract,
    SyncdClientDiscoveryGuidanceContract, SyncdClientDiscoveryUsageHint,
    SyncdDiscoveryAdvertisedOrigin, SyncdDiscoveryCapabilities, SyncdDiscoveryDescriptor,
    SyncdDiscoveryFailure, SyncdDiscoveryProviderKind, SyncdDiscoveryProviderLifecycle,
    SyncdDiscoveryProviderStatus, SyncdEffectiveDiscoveryCandidate, SyncdEffectiveDiscoveryOrigin,
    SyncdEffectiveDiscoverySource, SyncdManualDiscoveryOrigin, SyncdManualDiscoveryProviderStatus,
    SyncdManualDiscoveryPublication, SyncdPublishedDiscoveryService, SyncdPublishedTxtRecords,
};
use crate::syncd::db;

pub const SYNCD_DISCOVERY_DESCRIPTOR_VERSION: u32 = 1;
pub const SYNCD_CLIENT_DISCOVERY_CONTRACT_VERSION: u32 = 1;
pub const SYNCD_CLIENT_DISCOVERY_GUIDANCE_VERSION: u32 = 1;

#[derive(Clone, Debug, Default)]
pub struct SyncdDiscoveryDescriptorProvider;

#[derive(Clone, Debug, Default)]
pub struct SyncdClientDiscoveryContractProvider;

#[derive(Clone, Debug, Default)]
pub struct SyncdClientDiscoveryGuidanceProvider;

impl SyncdDiscoveryDescriptorProvider {
    pub fn from_config(config: &SyncdConfig) -> anyhow::Result<Self> {
        let _ = SyncdAdvertisedEndpointResolver::from_config(config)
            .context("discovery descriptor requires a valid advertised endpoint policy")?;
        Ok(Self)
    }

    #[cfg(test)]
    pub fn resolve_advertised_origin(
        &self,
        config: &SyncdConfig,
        resolver: &SyncdAdvertisedEndpointResolver,
    ) -> SyncdDiscoveryAdvertisedOrigin {
        let resolution = resolver.resolve(config.bind_addr);
        SyncdDiscoveryAdvertisedOrigin {
            base_url: resolution.selected.base_url(),
            policy_name: resolution.policy_name.to_string(),
        }
    }

    #[cfg(test)]
    pub fn build_descriptor(
        &self,
        config: &SyncdConfig,
        resolver: &SyncdAdvertisedEndpointResolver,
        server_identity: &ServerIdentityRow,
    ) -> anyhow::Result<SyncdDiscoveryDescriptor> {
        self.build_descriptor_with_origin(
            self.resolve_advertised_origin(config, resolver),
            server_identity,
        )
    }

    pub fn build_descriptor_with_origin(
        &self,
        advertised_origin: SyncdDiscoveryAdvertisedOrigin,
        server_identity: &ServerIdentityRow,
    ) -> anyhow::Result<SyncdDiscoveryDescriptor> {
        let server_protocol_version = u32::try_from(server_identity.server_protocol_version)
            .with_context(|| {
                format!(
                    "server protocol version '{}' cannot be represented as u32",
                    server_identity.server_protocol_version
                )
            })?;
        if server_identity.server_id.trim().is_empty() {
            bail!("server identity is missing a server_id");
        }

        Ok(SyncdDiscoveryDescriptor {
            descriptor_version: SYNCD_DISCOVERY_DESCRIPTOR_VERSION,
            server_id: server_identity.server_id.clone(),
            server_protocol_version,
            min_client_version: server_identity.min_client_version.clone(),
            tls_cert_sha256: server_identity.tls_cert_sha256.clone(),
            advertised_origin,
            capabilities: SyncdDiscoveryCapabilities {
                supports_bootstrap_session_create: true,
                supports_bootstrap_session_fetch: true,
                supports_live_pairing_status: true,
                supports_descriptor: true,
                has_advertised_endpoint: true,
            },
        })
    }
}

impl SyncdClientDiscoveryContractProvider {
    pub fn build_contract(
        &self,
        server_identity: &ServerIdentityRow,
        status: &SyncdDiscoveryProviderStatus,
    ) -> anyhow::Result<SyncdClientDiscoveryContract> {
        let server_protocol_version = u32::try_from(server_identity.server_protocol_version)
            .with_context(|| {
                format!(
                    "server protocol version '{}' cannot be represented as u32",
                    server_identity.server_protocol_version
                )
            })?;
        if server_identity.server_id.trim().is_empty() {
            bail!("server identity is missing a server_id");
        }

        Ok(SyncdClientDiscoveryContract {
            contract_version: SYNCD_CLIENT_DISCOVERY_CONTRACT_VERSION,
            server_id: server_identity.server_id.clone(),
            server_protocol_version,
            min_client_version: server_identity.min_client_version.clone(),
            tls_cert_sha256: server_identity.tls_cert_sha256.clone(),
            effective_origin: status.effective_origin.base_url.clone(),
            effective_source: status.effective_origin.source,
            effective_policy: status.effective_origin.policy,
            capabilities: SyncdClientDiscoveryCapabilities {
                supports_bootstrap_session_create: true,
                supports_bootstrap_session_fetch: true,
                supports_live_pairing_status: true,
                supports_descriptor: true,
            },
            candidates: build_client_discovery_candidates(status),
        })
    }
}

impl SyncdClientDiscoveryGuidanceProvider {
    pub fn build_guidance(
        &self,
        contract: &SyncdClientDiscoveryContract,
    ) -> anyhow::Result<SyncdClientDiscoveryGuidanceContract> {
        let attempts = contract
            .candidates
            .iter()
            .map(|candidate| SyncdClientDiscoveryAttemptGuidance {
                origin: candidate.base_url.clone(),
                source: candidate.origin_source,
                usage_hint: candidate.usage_hint,
                providers: candidate.providers.clone(),
                bootstrap_eligible: !matches!(
                    candidate.usage_hint,
                    SyncdClientDiscoveryUsageHint::Informational
                ) && contract.capabilities.supports_bootstrap_session_create
                    && contract.capabilities.supports_bootstrap_session_fetch,
                live_pairing_eligible: !matches!(
                    candidate.usage_hint,
                    SyncdClientDiscoveryUsageHint::Informational
                ) && contract.capabilities.supports_live_pairing_status,
                informational_only: matches!(
                    candidate.usage_hint,
                    SyncdClientDiscoveryUsageHint::Informational
                ),
            })
            .collect::<Vec<_>>();

        let canonical_attempt = attempts
            .iter()
            .find(|attempt| matches!(attempt.usage_hint, SyncdClientDiscoveryUsageHint::Canonical))
            .cloned()
            .or_else(|| attempts.first().cloned())
            .ok_or_else(|| anyhow::anyhow!("client discovery contract is missing candidates"))?;

        let fallback_attempts = attempts
            .into_iter()
            .filter(|attempt| {
                matches!(attempt.usage_hint, SyncdClientDiscoveryUsageHint::Fallback)
                    && !attempt.informational_only
            })
            .collect::<Vec<_>>();

        Ok(SyncdClientDiscoveryGuidanceContract {
            guidance_version: SYNCD_CLIENT_DISCOVERY_GUIDANCE_VERSION,
            contract_version: contract.contract_version,
            effective_origin: contract.effective_origin.clone(),
            effective_source: contract.effective_source,
            effective_policy: contract.effective_policy,
            candidates_are_normalized_and_deduped: true,
            canonical_attempt,
            behavior: SyncdClientDiscoveryBehaviorGuidance {
                continue_on_connection_failure: !fallback_attempts.is_empty(),
                continue_on_tls_mismatch: false,
                continue_on_bootstrap_rejection: false,
                continue_on_not_found_or_expired: false,
            },
            fallback_attempts,
        })
    }
}

#[derive(Clone, Debug)]
pub struct SyncdDiscoveryProviderManager {
    lan_mode: SyncdDiscoveryProviderMode,
    manual_mode: SyncdManualDiscoveryProviderMode,
    effective_policy: SyncdEffectiveDiscoveryPolicy,
}

pub struct SyncdDiscoveryRuntimeHandle {
    runtime: SyncdDiscoveryProviderRuntime,
}

enum SyncdDiscoveryProviderRuntime {
    LanPublication(SyncdLanPublicationRuntime),
}

struct SyncdLanPublicationRuntime {
    daemon: ServiceDaemon,
    monitor_task: JoinHandle<()>,
}

impl Drop for SyncdDiscoveryRuntimeHandle {
    fn drop(&mut self) {
        match &self.runtime {
            SyncdDiscoveryProviderRuntime::LanPublication(runtime) => {
                runtime.monitor_task.abort();
                let _ = runtime.daemon.shutdown();
            }
        }
    }
}

impl SyncdDiscoveryProviderManager {
    pub fn from_config(config: &SyncdConfig) -> anyhow::Result<Self> {
        let _ = SyncdAdvertisedEndpointResolver::from_config(config)
            .context("discovery provider requires a valid advertised endpoint policy")?;
        Ok(Self {
            lan_mode: config.discovery_provider_mode,
            manual_mode: config.manual_discovery_provider_mode,
            effective_policy: config.effective_discovery_policy,
        })
    }

    pub fn initial_status(
        &self,
        config: &SyncdConfig,
        resolver: &SyncdAdvertisedEndpointResolver,
    ) -> SyncdDiscoveryProviderStatus {
        let manual_provider = self.initial_manual_status();
        SyncdDiscoveryProviderStatus {
            provider_mode: self.lan_mode,
            lifecycle: match self.lan_mode {
                SyncdDiscoveryProviderMode::Disabled => SyncdDiscoveryProviderLifecycle::Disabled,
                SyncdDiscoveryProviderMode::LanPublication => {
                    SyncdDiscoveryProviderLifecycle::Starting
                }
            },
            publication: None,
            failure: None,
            effective_origin: self.resolve_effective_origin(config, resolver, &manual_provider),
            manual_provider,
            updated_at_ms: db::now_ms(),
        }
    }

    #[allow(dead_code)]
    pub fn stopping_status(
        &self,
        config: &SyncdConfig,
        resolver: &SyncdAdvertisedEndpointResolver,
    ) -> SyncdDiscoveryProviderStatus {
        let manual_provider = SyncdManualDiscoveryProviderStatus {
            provider_mode: self.manual_mode,
            lifecycle: SyncdDiscoveryProviderLifecycle::Stopping,
            publication: None,
            failure: None,
            updated_at_ms: db::now_ms(),
        };
        SyncdDiscoveryProviderStatus {
            provider_mode: self.lan_mode,
            lifecycle: SyncdDiscoveryProviderLifecycle::Stopping,
            publication: None,
            failure: None,
            effective_origin: self.resolve_effective_origin(config, resolver, &manual_provider),
            manual_provider,
            updated_at_ms: db::now_ms(),
        }
    }

    pub fn start_status(
        &self,
        config: &SyncdConfig,
        descriptor_provider: &SyncdDiscoveryDescriptorProvider,
        resolver: &SyncdAdvertisedEndpointResolver,
        server_identity: &ServerIdentityRow,
    ) -> SyncdDiscoveryProviderStatus {
        let manual_provider = self.start_manual_status(config);
        let effective_origin = self.resolve_effective_origin(config, resolver, &manual_provider);
        match self.lan_mode {
            SyncdDiscoveryProviderMode::Disabled => self.initial_status(config, resolver),
            SyncdDiscoveryProviderMode::LanPublication => {
                match self.build_lan_publication(
                    config,
                    descriptor_provider,
                    server_identity,
                    &effective_origin,
                ) {
                    Ok(publication) => SyncdDiscoveryProviderStatus {
                        provider_mode: self.lan_mode,
                        lifecycle: SyncdDiscoveryProviderLifecycle::Active,
                        publication: Some(publication),
                        failure: None,
                        effective_origin,
                        manual_provider,
                        updated_at_ms: db::now_ms(),
                    },
                    Err(error) => SyncdDiscoveryProviderStatus {
                        provider_mode: self.lan_mode,
                        lifecycle: SyncdDiscoveryProviderLifecycle::Failed,
                        publication: None,
                        failure: Some(SyncdDiscoveryFailure {
                            code: "DISCOVERY_PROVIDER_START_FAILED".to_string(),
                            message: error.to_string(),
                        }),
                        effective_origin,
                        manual_provider,
                        updated_at_ms: db::now_ms(),
                    },
                }
            }
        }
    }

    fn initial_manual_status(&self) -> SyncdManualDiscoveryProviderStatus {
        SyncdManualDiscoveryProviderStatus {
            provider_mode: self.manual_mode,
            lifecycle: match self.manual_mode {
                SyncdManualDiscoveryProviderMode::Disabled => {
                    SyncdDiscoveryProviderLifecycle::Disabled
                }
                SyncdManualDiscoveryProviderMode::Enabled => {
                    SyncdDiscoveryProviderLifecycle::Starting
                }
            },
            publication: None,
            failure: None,
            updated_at_ms: db::now_ms(),
        }
    }

    fn start_manual_status(&self, config: &SyncdConfig) -> SyncdManualDiscoveryProviderStatus {
        match self.manual_mode {
            SyncdManualDiscoveryProviderMode::Disabled => self.initial_manual_status(),
            SyncdManualDiscoveryProviderMode::Enabled => match build_manual_publication(config) {
                Ok(publication) => SyncdManualDiscoveryProviderStatus {
                    provider_mode: self.manual_mode,
                    lifecycle: SyncdDiscoveryProviderLifecycle::Active,
                    publication: Some(publication),
                    failure: None,
                    updated_at_ms: db::now_ms(),
                },
                Err(error) => SyncdManualDiscoveryProviderStatus {
                    provider_mode: self.manual_mode,
                    lifecycle: SyncdDiscoveryProviderLifecycle::Failed,
                    publication: None,
                    failure: Some(SyncdDiscoveryFailure {
                        code: "MANUAL_DISCOVERY_PROVIDER_START_FAILED".to_string(),
                        message: error.to_string(),
                    }),
                    updated_at_ms: db::now_ms(),
                },
            },
        }
    }

    fn build_lan_publication(
        &self,
        config: &SyncdConfig,
        descriptor_provider: &SyncdDiscoveryDescriptorProvider,
        server_identity: &ServerIdentityRow,
        effective_origin: &SyncdEffectiveDiscoveryOrigin,
    ) -> anyhow::Result<SyncdPublishedDiscoveryService> {
        validate_service_type(&config.mdns_service_name)?;
        let descriptor = descriptor_provider.build_descriptor_with_origin(
            effective_origin.as_advertised_origin(),
            server_identity,
        )?;
        let short_server_id = descriptor.server_id.chars().take(8).collect::<String>();
        let port = advertised_origin_port(&descriptor.advertised_origin.base_url)?;
        let instance_name = format!("aethon-syncd-{short_server_id}");
        let host_name = format!("{instance_name}.local.");
        let txt_records = build_txt_records(&descriptor);

        Ok(SyncdPublishedDiscoveryService {
            provider_kind: SyncdDiscoveryProviderKind::LanPublication,
            service_type: config.mdns_service_name.clone(),
            instance_name,
            host_name,
            port,
            txt_records,
            descriptor,
        })
    }

    pub fn resolve_effective_origin(
        &self,
        config: &SyncdConfig,
        resolver: &SyncdAdvertisedEndpointResolver,
        manual_provider: &SyncdManualDiscoveryProviderStatus,
    ) -> SyncdEffectiveDiscoveryOrigin {
        let raw_advertised = resolver.resolve(config.bind_addr);
        let advertised_base_url = raw_advertised.selected.base_url();
        let advertised_candidate = SyncdEffectiveDiscoveryCandidate {
            base_url: advertised_base_url.clone(),
            source: SyncdEffectiveDiscoverySource::AdvertisedEndpoint,
        };

        let mut ordered_candidates = Vec::new();
        match self.effective_policy {
            SyncdEffectiveDiscoveryPolicy::AdvertisedOnly => {
                ordered_candidates.push(advertised_candidate);
                ordered_candidates.extend(self.manual_candidates(manual_provider));
            }
            SyncdEffectiveDiscoveryPolicy::ManualPreferred => {
                ordered_candidates.extend(self.manual_candidates(manual_provider));
                ordered_candidates.push(advertised_candidate);
            }
        }

        let candidates = dedupe_effective_candidates(ordered_candidates);
        let selected = candidates
            .first()
            .cloned()
            .unwrap_or(SyncdEffectiveDiscoveryCandidate {
                base_url: advertised_base_url,
                source: SyncdEffectiveDiscoverySource::AdvertisedEndpoint,
            });

        SyncdEffectiveDiscoveryOrigin {
            base_url: selected.base_url,
            source: selected.source,
            policy: self.effective_policy,
            candidates,
        }
    }

    fn manual_candidates(
        &self,
        manual_provider: &SyncdManualDiscoveryProviderStatus,
    ) -> Vec<SyncdEffectiveDiscoveryCandidate> {
        manual_provider
            .publication
            .as_ref()
            .map(|publication| {
                publication
                    .origins
                    .iter()
                    .map(|origin| SyncdEffectiveDiscoveryCandidate {
                        base_url: origin.base_url.clone(),
                        source: SyncdEffectiveDiscoverySource::ManualEndpoint,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn build_manual_publication(
    config: &SyncdConfig,
) -> anyhow::Result<SyncdManualDiscoveryPublication> {
    if config.manual_discovery_origins.is_empty() {
        bail!("manual discovery provider requires at least one origin");
    }

    let origins = config
        .manual_discovery_origins
        .iter()
        .map(|raw| normalize_manual_origin(raw))
        .collect::<anyhow::Result<Vec<_>>>()?;

    Ok(SyncdManualDiscoveryPublication {
        provider_kind: SyncdDiscoveryProviderKind::ManualEndpoint,
        origins,
    })
}

fn normalize_manual_origin(raw: &str) -> anyhow::Result<SyncdManualDiscoveryOrigin> {
    let endpoint = SyncdAdvertisedEndpoint::parse(raw)
        .with_context(|| format!("manual discovery origin '{raw}' is invalid"))?;
    Ok(SyncdManualDiscoveryOrigin {
        base_url: endpoint.base_url(),
    })
}

fn dedupe_effective_candidates(
    candidates: Vec<SyncdEffectiveDiscoveryCandidate>,
) -> Vec<SyncdEffectiveDiscoveryCandidate> {
    let mut seen = std::collections::BTreeSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.base_url.clone()))
        .collect()
}

fn build_client_discovery_candidates(
    status: &SyncdDiscoveryProviderStatus,
) -> Vec<SyncdClientDiscoveryCandidate> {
    status
        .effective_origin
        .candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| SyncdClientDiscoveryCandidate {
            base_url: candidate.base_url.clone(),
            origin_source: candidate.source,
            usage_hint: if index == 0 {
                SyncdClientDiscoveryUsageHint::Canonical
            } else {
                SyncdClientDiscoveryUsageHint::Fallback
            },
            providers: providers_for_candidate(status, &candidate.base_url),
        })
        .collect()
}

fn providers_for_candidate(
    status: &SyncdDiscoveryProviderStatus,
    base_url: &str,
) -> Vec<SyncdDiscoveryProviderKind> {
    let mut providers = Vec::new();

    if let Some(publication) = status.manual_provider.publication.as_ref() {
        if publication
            .origins
            .iter()
            .any(|origin| origin.base_url == base_url)
        {
            providers.push(SyncdDiscoveryProviderKind::ManualEndpoint);
        }
    }

    if let Some(publication) = status.publication.as_ref() {
        if publication.descriptor.advertised_origin.base_url == base_url {
            providers.push(SyncdDiscoveryProviderKind::LanPublication);
        }
    }

    providers
}

pub async fn start_discovery_provider(state: SharedAppState) {
    let server_identity = match db::load_server_identity(&state.pool).await {
        Ok(server_identity) => server_identity,
        Err(error) => {
            let initial = state
                .discovery_provider_manager
                .initial_status(&state.config, &state.advertised_endpoint_resolver);
            let mut guard = state.discovery_provider_state.write().await;
            *guard = SyncdDiscoveryProviderStatus {
                provider_mode: state.config.discovery_provider_mode,
                lifecycle: SyncdDiscoveryProviderLifecycle::Failed,
                publication: None,
                failure: Some(SyncdDiscoveryFailure {
                    code: "DISCOVERY_PROVIDER_IDENTITY_LOAD_FAILED".to_string(),
                    message: error.to_string(),
                }),
                effective_origin: initial.effective_origin,
                manual_provider: initial.manual_provider,
                updated_at_ms: db::now_ms(),
            };
            tracing::warn!(error = %error, "syncd discovery provider failed to load server identity");
            return;
        }
    };

    let mut status = state.discovery_provider_manager.start_status(
        &state.config,
        &state.discovery_descriptor_provider,
        &state.advertised_endpoint_resolver,
        &server_identity,
    );

    {
        let mut runtime_guard = state.discovery_provider_runtime.lock().await;
        runtime_guard.take();
    }

    if let Some(publication) = status.publication.clone() {
        match start_lan_publication_runtime(state.clone(), publication) {
            Ok(runtime) => {
                let mut runtime_guard = state.discovery_provider_runtime.lock().await;
                *runtime_guard = Some(runtime);
            }
            Err(error) => {
                status = SyncdDiscoveryProviderStatus {
                    provider_mode: state.config.discovery_provider_mode,
                    lifecycle: SyncdDiscoveryProviderLifecycle::Failed,
                    publication: None,
                    failure: Some(SyncdDiscoveryFailure {
                        code: "DISCOVERY_PROVIDER_START_FAILED".to_string(),
                        message: error.to_string(),
                    }),
                    effective_origin: status.effective_origin.clone(),
                    manual_provider: status.manual_provider.clone(),
                    updated_at_ms: db::now_ms(),
                };
            }
        }
    }

    if let Some(failure) = status.failure.as_ref() {
        tracing::warn!(
            code = %failure.code,
            message = %failure.message,
            "syncd discovery provider failed to start"
        );
    }

    let mut guard = state.discovery_provider_state.write().await;
    *guard = status;
}

fn start_lan_publication_runtime(
    state: SharedAppState,
    publication: SyncdPublishedDiscoveryService,
) -> anyhow::Result<SyncdDiscoveryRuntimeHandle> {
    let daemon =
        ServiceDaemon::new_with_port(state.config.discovery_mdns_port).with_context(|| {
            format!(
                "failed to create mDNS daemon on port {}",
                state.config.discovery_mdns_port
            )
        })?;
    let properties = txt_record_pairs(&publication.txt_records);
    let mut service_info = ServiceInfo::new(
        &transport_service_type(&publication.service_type),
        &publication.instance_name,
        &publication.host_name,
        (),
        publication.port,
        &properties[..],
    )
    .with_context(|| {
        format!(
            "failed to build service info for '{}'",
            publication.instance_name
        )
    })?;
    service_info = service_info.enable_addr_auto();

    let monitor = daemon.monitor().context("failed to monitor mDNS daemon")?;
    let monitor_task = spawn_mdns_monitor_task(state, publication.clone(), monitor);
    daemon.register(service_info).with_context(|| {
        format!(
            "failed to register mDNS service '{}'",
            publication.instance_name
        )
    })?;

    Ok(SyncdDiscoveryRuntimeHandle {
        runtime: SyncdDiscoveryProviderRuntime::LanPublication(SyncdLanPublicationRuntime {
            daemon,
            monitor_task,
        }),
    })
}

fn spawn_mdns_monitor_task(
    state: SharedAppState,
    publication: SyncdPublishedDiscoveryService,
    monitor: Receiver<DaemonEvent>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match monitor.recv_async().await {
                Ok(DaemonEvent::Error(error)) => {
                    tracing::warn!(
                        error = %error,
                        instance_name = %publication.instance_name,
                        "syncd discovery provider runtime error"
                    );
                    let mut guard = state.discovery_provider_state.write().await;
                    let manual_provider = guard.manual_provider.clone();
                    *guard = SyncdDiscoveryProviderStatus {
                        provider_mode: state.config.discovery_provider_mode,
                        lifecycle: SyncdDiscoveryProviderLifecycle::Failed,
                        publication: None,
                        failure: Some(SyncdDiscoveryFailure {
                            code: "DISCOVERY_PROVIDER_RUNTIME_ERROR".to_string(),
                            message: error.to_string(),
                        }),
                        effective_origin: guard.effective_origin.clone(),
                        manual_provider,
                        updated_at_ms: db::now_ms(),
                    };
                    break;
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(
                        error = %error,
                        instance_name = %publication.instance_name,
                        "syncd discovery provider monitor closed"
                    );
                    let mut guard = state.discovery_provider_state.write().await;
                    let manual_provider = guard.manual_provider.clone();
                    *guard = SyncdDiscoveryProviderStatus {
                        provider_mode: state.config.discovery_provider_mode,
                        lifecycle: SyncdDiscoveryProviderLifecycle::Failed,
                        publication: None,
                        failure: Some(SyncdDiscoveryFailure {
                            code: "DISCOVERY_PROVIDER_MONITOR_CLOSED".to_string(),
                            message: error.to_string(),
                        }),
                        effective_origin: guard.effective_origin.clone(),
                        manual_provider,
                        updated_at_ms: db::now_ms(),
                    };
                    break;
                }
            }
        }
    })
}

fn build_txt_records(descriptor: &SyncdDiscoveryDescriptor) -> SyncdPublishedTxtRecords {
    SyncdPublishedTxtRecords {
        descriptor_version: descriptor.descriptor_version,
        server_id: descriptor.server_id.clone(),
        server_protocol_version: descriptor.server_protocol_version,
        min_client_version: descriptor.min_client_version.clone(),
        advertised_base_url: descriptor.advertised_origin.base_url.clone(),
        supports_bootstrap_session_create: descriptor
            .capabilities
            .supports_bootstrap_session_create,
        supports_bootstrap_session_fetch: descriptor.capabilities.supports_bootstrap_session_fetch,
        supports_live_pairing_status: descriptor.capabilities.supports_live_pairing_status,
        supports_descriptor: descriptor.capabilities.supports_descriptor,
        tls_cert_sha256: descriptor.tls_cert_sha256.clone(),
    }
}

fn txt_record_pairs(txt_records: &SyncdPublishedTxtRecords) -> Vec<(String, String)> {
    vec![
        (
            "desc_v".to_string(),
            txt_records.descriptor_version.to_string(),
        ),
        ("sid".to_string(), txt_records.server_id.clone()),
        (
            "proto_v".to_string(),
            txt_records.server_protocol_version.to_string(),
        ),
        (
            "min_client".to_string(),
            txt_records.min_client_version.clone(),
        ),
        (
            "origin".to_string(),
            txt_records.advertised_base_url.clone(),
        ),
        (
            "caps_bootstrap_create".to_string(),
            bool_txt(txt_records.supports_bootstrap_session_create),
        ),
        (
            "caps_bootstrap_fetch".to_string(),
            bool_txt(txt_records.supports_bootstrap_session_fetch),
        ),
        (
            "caps_live_pairing".to_string(),
            bool_txt(txt_records.supports_live_pairing_status),
        ),
        (
            "caps_descriptor".to_string(),
            bool_txt(txt_records.supports_descriptor),
        ),
        (
            "tls_sha256".to_string(),
            txt_records.tls_cert_sha256.clone(),
        ),
    ]
}

fn bool_txt(value: bool) -> String {
    if value { "1" } else { "0" }.to_string()
}

fn transport_service_type(service_type: &str) -> String {
    if service_type.ends_with('.') {
        service_type.to_string()
    } else {
        format!("{service_type}.")
    }
}

fn advertised_origin_port(base_url: &str) -> anyhow::Result<u16> {
    Url::parse(base_url)
        .with_context(|| format!("failed to parse advertised origin '{base_url}'"))?
        .port_or_known_default()
        .ok_or_else(|| anyhow::anyhow!("advertised origin '{base_url}' is missing a port"))
}

fn validate_service_type(service_type: &str) -> anyhow::Result<()> {
    let value = service_type.trim();
    if value.is_empty() {
        bail!("discovery service type must not be empty");
    }
    if value.contains(char::is_whitespace) {
        bail!("discovery service type must not contain whitespace");
    }
    if !value.starts_with('_') {
        bail!("discovery service type must start with '_'");
    }
    if !(value.ends_with("._tcp.local") || value.ends_with("._tcp.local.")) {
        bail!("discovery service type must end with '._tcp.local' or '._tcp.local.'");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::syncd::config::{
        SyncdConfig, SyncdEffectiveDiscoveryPolicy, SyncdManualDiscoveryProviderMode,
    };
    use crate::syncd::db::{connect, upsert_server_identity};
    use crate::syncd::models::AppState;
    use mdns_sd::{ServiceDaemon, ServiceEvent};
    use tempfile::tempdir;
    use tokio::sync::{broadcast, Mutex, RwLock};

    fn server_identity_row() -> ServerIdentityRow {
        ServerIdentityRow {
            server_id: "syncd-server".to_string(),
            server_protocol_version: 1,
            min_client_version: "0.1.0".to_string(),
            tls_cert_sha256: "fingerprint".to_string(),
            mdns_service_name: "_aethon-sync._tcp.local.".to_string(),
        }
    }

    #[test]
    fn provider_builds_default_descriptor_from_bind_resolution() {
        let config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-discovery"));
        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let provider = SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();

        let descriptor = provider
            .build_descriptor(&config, &resolver, &server_identity_row())
            .unwrap();

        assert_eq!(descriptor.descriptor_version, 1);
        assert_eq!(
            descriptor.advertised_origin.base_url,
            "https://127.0.0.1:4777"
        );
        assert_eq!(descriptor.advertised_origin.policy_name, "auto_bind");
        assert!(descriptor.capabilities.supports_live_pairing_status);
    }

    #[test]
    fn provider_reflects_override_origin() {
        let mut config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-discovery"));
        config.advertised_base_url = Some("https://localhost:9443".to_string());
        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let provider = SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();

        let descriptor = provider
            .build_descriptor(&config, &resolver, &server_identity_row())
            .unwrap();

        assert_eq!(
            descriptor.advertised_origin.base_url,
            "https://localhost:9443"
        );
        assert_eq!(descriptor.advertised_origin.policy_name, "override");
    }

    #[test]
    fn provider_rejects_invalid_discovery_config() {
        let mut config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-discovery"));
        config.advertised_base_url = Some("http://localhost:4777/path".to_string());

        let error = SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("advertised endpoint") || message.contains("https"));
    }

    #[test]
    fn provider_manager_reports_disabled_state() {
        let mut config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-discovery"));
        config.discovery_provider_mode = SyncdDiscoveryProviderMode::Disabled;
        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let manager = SyncdDiscoveryProviderManager::from_config(&config).unwrap();

        let status = manager.initial_status(&config, &resolver);
        assert_eq!(status.provider_mode, SyncdDiscoveryProviderMode::Disabled);
        assert_eq!(status.lifecycle, SyncdDiscoveryProviderLifecycle::Disabled);
        assert!(status.publication.is_none());
        assert_eq!(status.effective_origin.base_url, "https://127.0.0.1:4777");
        assert_eq!(
            status.manual_provider.provider_mode,
            SyncdManualDiscoveryProviderMode::Disabled
        );
        assert_eq!(
            status.manual_provider.lifecycle,
            SyncdDiscoveryProviderLifecycle::Disabled
        );
    }

    #[test]
    fn provider_manager_reaches_active_state_with_valid_service_type() {
        let config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-discovery"));
        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let descriptor_provider = SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();
        let manager = SyncdDiscoveryProviderManager::from_config(&config).unwrap();

        let status = manager.start_status(
            &config,
            &descriptor_provider,
            &resolver,
            &server_identity_row(),
        );

        assert_eq!(status.lifecycle, SyncdDiscoveryProviderLifecycle::Active);
        let publication = status.publication.unwrap();
        assert_eq!(
            publication.provider_kind,
            SyncdDiscoveryProviderKind::LanPublication
        );
        assert_eq!(publication.service_type, "_aethon-sync._tcp.local.");
        assert_eq!(publication.port, 4777);
        assert_eq!(publication.host_name, "aethon-syncd-syncd-se.local.");
        assert_eq!(
            publication.descriptor.advertised_origin.base_url,
            "https://127.0.0.1:4777"
        );
        assert_eq!(
            publication.txt_records.advertised_base_url,
            "https://127.0.0.1:4777"
        );
        assert!(publication.txt_records.supports_live_pairing_status);
        assert_eq!(
            status.manual_provider.lifecycle,
            SyncdDiscoveryProviderLifecycle::Disabled
        );
    }

    #[test]
    fn provider_manager_reports_failed_state_for_invalid_service_type() {
        let mut config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-discovery"));
        config.mdns_service_name = "invalid-service".to_string();
        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let descriptor_provider = SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();
        let manager = SyncdDiscoveryProviderManager::from_config(&config).unwrap();

        let status = manager.start_status(
            &config,
            &descriptor_provider,
            &resolver,
            &server_identity_row(),
        );

        assert_eq!(status.lifecycle, SyncdDiscoveryProviderLifecycle::Failed);
        assert!(status.publication.is_none());
        let failure = status.failure.unwrap();
        assert_eq!(failure.code, "DISCOVERY_PROVIDER_START_FAILED");
        assert!(failure.message.contains("must start with '_'"));
    }

    #[test]
    fn provider_manager_exposes_stopping_state() {
        let config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-discovery"));
        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let manager = SyncdDiscoveryProviderManager::from_config(&config).unwrap();

        let status = manager.stopping_status(&config, &resolver);
        assert_eq!(status.lifecycle, SyncdDiscoveryProviderLifecycle::Stopping);
        assert_eq!(
            status.manual_provider.lifecycle,
            SyncdDiscoveryProviderLifecycle::Stopping
        );
    }

    #[test]
    fn manual_provider_accepts_and_normalizes_configured_origins() {
        let mut config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-discovery"));
        config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
        config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        config.manual_discovery_origins = vec![
            "https://localhost:4777/".to_string(),
            "https://localhost:4777".to_string(),
            "https://[::1]:4777".to_string(),
        ];
        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let descriptor_provider = SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();
        let manager = SyncdDiscoveryProviderManager::from_config(&config).unwrap();

        let status = manager.start_status(
            &config,
            &descriptor_provider,
            &resolver,
            &server_identity_row(),
        );

        assert_eq!(status.lifecycle, SyncdDiscoveryProviderLifecycle::Active);
        assert_eq!(
            status.manual_provider.lifecycle,
            SyncdDiscoveryProviderLifecycle::Active
        );
        let publication = status.manual_provider.publication.unwrap();
        assert_eq!(
            publication.provider_kind,
            SyncdDiscoveryProviderKind::ManualEndpoint
        );
        assert_eq!(publication.origins[0].base_url, "https://localhost:4777");
        assert_eq!(publication.origins[1].base_url, "https://localhost:4777");
        assert_eq!(publication.origins[2].base_url, "https://[::1]:4777");
        assert_eq!(status.effective_origin.base_url, "https://localhost:4777");
        assert_eq!(
            status.effective_origin.source,
            SyncdEffectiveDiscoverySource::ManualEndpoint
        );
        assert_eq!(status.effective_origin.candidates.len(), 3);
    }

    #[test]
    fn manual_origin_rejects_invalid_scheme() {
        let error = normalize_manual_origin("http://localhost:4777").unwrap_err();
        let message = error.to_string();
        assert!(message.contains("https") || message.contains("invalid"));
    }

    #[test]
    fn manual_origin_rejects_missing_host() {
        let error = normalize_manual_origin("https://:4777").unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("host") || message.contains("parse") || message.contains("invalid")
        );
    }

    #[test]
    fn manual_origin_rejects_invalid_port() {
        let error = normalize_manual_origin("https://localhost:99999").unwrap_err();
        let message = error.to_string();
        assert!(
            message.contains("port") || message.contains("parse") || message.contains("invalid")
        );
    }

    #[test]
    fn manual_provider_failure_is_contained_when_config_invalid() {
        let mut config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-discovery"));
        config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
        config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        config.manual_discovery_origins = vec!["http://localhost:4777".to_string()];
        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let descriptor_provider = SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();
        let manager = SyncdDiscoveryProviderManager::from_config(&config).unwrap();

        let status = manager.start_status(
            &config,
            &descriptor_provider,
            &resolver,
            &server_identity_row(),
        );

        assert_eq!(status.lifecycle, SyncdDiscoveryProviderLifecycle::Active);
        assert_eq!(
            status.manual_provider.lifecycle,
            SyncdDiscoveryProviderLifecycle::Failed
        );
        assert!(status.manual_provider.publication.is_none());
        assert_eq!(
            status.manual_provider.failure.unwrap().code,
            "MANUAL_DISCOVERY_PROVIDER_START_FAILED"
        );
        assert_eq!(
            status.effective_origin.source,
            SyncdEffectiveDiscoverySource::AdvertisedEndpoint
        );
    }

    #[test]
    fn advertised_only_policy_keeps_advertised_origin_even_with_valid_manual_provider() {
        let mut config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-discovery"));
        config.advertised_base_url = Some("https://127.0.0.1:4777".to_string());
        config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        config.manual_discovery_origins = vec!["https://localhost:4777".to_string()];
        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let descriptor_provider = SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();
        let manager = SyncdDiscoveryProviderManager::from_config(&config).unwrap();

        let status = manager.start_status(
            &config,
            &descriptor_provider,
            &resolver,
            &server_identity_row(),
        );

        assert_eq!(status.lifecycle, SyncdDiscoveryProviderLifecycle::Active);
        assert_eq!(
            status.effective_origin.source,
            SyncdEffectiveDiscoverySource::AdvertisedEndpoint
        );
        assert_eq!(status.effective_origin.base_url, "https://127.0.0.1:4777");
        assert_eq!(status.effective_origin.candidates.len(), 2);
    }

    #[test]
    fn manual_preferred_policy_selects_manual_origin_and_dedupes_equivalent_candidates() {
        let mut config = SyncdConfig::for_test(PathBuf::from("C:\\temp\\syncd-discovery"));
        config.effective_discovery_policy = SyncdEffectiveDiscoveryPolicy::ManualPreferred;
        config.advertised_base_url = Some("https://127.0.0.1:4777".to_string());
        config.manual_discovery_provider_mode = SyncdManualDiscoveryProviderMode::Enabled;
        config.manual_discovery_origins = vec![
            "https://localhost:4777/".to_string(),
            "https://localhost:4777".to_string(),
            "https://127.0.0.1:4777".to_string(),
        ];
        let resolver = SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let descriptor_provider = SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();
        let manager = SyncdDiscoveryProviderManager::from_config(&config).unwrap();

        let status = manager.start_status(
            &config,
            &descriptor_provider,
            &resolver,
            &server_identity_row(),
        );

        assert_eq!(status.lifecycle, SyncdDiscoveryProviderLifecycle::Active);
        assert_eq!(status.effective_origin.base_url, "https://localhost:4777");
        assert_eq!(
            status.effective_origin.source,
            SyncdEffectiveDiscoverySource::ManualEndpoint
        );
        assert_eq!(status.effective_origin.candidates.len(), 2);
        assert_eq!(
            status.effective_origin.candidates[0].base_url,
            "https://localhost:4777"
        );
        assert_eq!(
            status.effective_origin.candidates[1].base_url,
            "https://127.0.0.1:4777"
        );
    }

    #[tokio::test]
    async fn start_discovery_provider_publishes_real_mdns_service() {
        let temp = tempdir().unwrap();
        let mut config = SyncdConfig::for_test(temp.path().to_path_buf());
        config.discovery_mdns_port = 5459;
        let pool = connect(&config).await.unwrap();
        upsert_server_identity(&pool, &config, "fingerprint")
            .await
            .unwrap();
        let advertised_endpoint_resolver =
            SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
        let discovery_descriptor_provider =
            SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();
        let discovery_provider_manager =
            SyncdDiscoveryProviderManager::from_config(&config).unwrap();
        let initial_status =
            discovery_provider_manager.initial_status(&config, &advertised_endpoint_resolver);
        let (change_sender, _) = broadcast::channel(32);
        let (pairing_status_sender, _) = broadcast::channel(64);
        let state = Arc::new(AppState {
            config: config.clone(),
            advertised_endpoint_resolver,
            discovery_descriptor_provider,
            client_discovery_contract_provider: SyncdClientDiscoveryContractProvider::default(),
            client_discovery_guidance_provider: SyncdClientDiscoveryGuidanceProvider::default(),
            discovery_provider_manager: discovery_provider_manager.clone(),
            discovery_provider_state: Arc::new(RwLock::new(initial_status)),
            discovery_provider_runtime: Arc::new(Mutex::new(None)),
            pool,
            change_sender,
            pairing_status_sender,
            mutation_gate: Arc::new(Mutex::new(())),
            tls_cert_sha256: "fingerprint".to_string(),
        });

        start_discovery_provider(state.clone()).await;

        let status = state.discovery_provider_state.read().await.clone();
        assert_eq!(status.lifecycle, SyncdDiscoveryProviderLifecycle::Active);
        let publication = status.publication.unwrap();
        let browser = ServiceDaemon::new_with_port(state.config.discovery_mdns_port).unwrap();
        let receiver = browser
            .browse(&transport_service_type(&publication.service_type))
            .unwrap();

        let resolved = tokio::task::spawn_blocking(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                let timeout = deadline.saturating_duration_since(std::time::Instant::now());
                if timeout.is_zero() {
                    panic!("timed out waiting for mdns service resolution");
                }
                match receiver.recv_deadline(std::time::Instant::now() + timeout) {
                    Ok(ServiceEvent::ServiceResolved(info)) => return info,
                    Ok(_) => continue,
                    Err(error) => panic!("failed to browse mdns service: {error}"),
                }
            }
        })
        .await
        .unwrap();

        assert_eq!(resolved.get_port(), publication.port);
        assert_eq!(resolved.get_hostname(), publication.host_name);
        assert_eq!(
            resolved.get_property_val_str("origin").unwrap(),
            publication.txt_records.advertised_base_url
        );
        assert_eq!(
            resolved.get_property_val_str("tls_sha256").unwrap(),
            publication.txt_records.tls_cert_sha256
        );
        assert!(resolved.get_property_val_str("token").is_none());
        let raw = format!("{resolved:?}");
        assert!(!raw.contains("accessToken"));

        let _ = browser.shutdown();
    }
}
