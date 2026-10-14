#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[allow(dead_code)]
mod suwayomi_maintenance;
#[allow(dead_code)]
mod suwayomi_runtime;
#[allow(dead_code)]
mod suwayomi_runtime_store;
mod syncd;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    epigraph_lib::promote_legacy_environment();
    epigraph_lib::migrate_legacy_core_storage();
    syncd::run_command_line().await
}
