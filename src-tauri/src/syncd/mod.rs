pub mod app;
pub mod autostart;
pub mod config;
pub mod db;
pub mod discovery;
pub mod extension_store_seed;
pub mod lifecycle;
pub mod listener;
pub mod middleware;
pub mod models;
pub mod network;
pub mod pairing_pin;
pub mod replay;
pub mod routes;
pub mod runtime_manifest;
pub mod suwayomi_process;
pub mod suwayomi_progress_mirror;
pub mod suwayomi_projection;
pub mod suwayomi_tracking_mirror;
pub mod tls;
pub mod tracker_credentials;
pub mod tracking;

pub async fn run_command_line() -> anyhow::Result<()> {
    lifecycle::run_command_line().await
}
