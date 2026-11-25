#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[allow(dead_code)]
mod suwayomi_maintenance;
#[allow(dead_code)]
mod suwayomi_recovery;
#[allow(dead_code)]
mod suwayomi_runtime;
#[allow(dead_code)]
mod suwayomi_runtime_store;
// This binary compiles the whole `syncd` tree but runs only the daemon half. The desktop app
// (`epigraph_lib`) uses the rest, so those items look unused here. To find real dead code, delete
// what this target reports and keep only what still compiles with `cargo check --bins --lib --tests`.
#[allow(dead_code)]
mod syncd;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    epigraph_lib::promote_legacy_environment();
    epigraph_lib::migrate_legacy_core_storage();
    syncd::run_command_line().await
}
