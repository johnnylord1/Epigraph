pub mod app;
pub mod autostart;
pub mod compression;
pub mod config;
pub mod db;
pub mod device_presence;
pub mod discovery;
pub mod extension_store_seed;
pub mod landed_works;
pub mod lifecycle;
pub mod listener;
pub mod middleware;
pub mod models;
pub mod myanimelist_oauth;
pub mod network;
pub mod novel_plugin_settings;
pub mod pairing_pin;
pub mod routes;
pub mod runtime_manifest;
pub mod source_preferences;
pub mod suwayomi_process;
pub mod suwayomi_tracker_prefs;
pub mod suwayomi_tracking_mirror;
#[cfg(test)]
mod test_dir;
pub mod tls;
pub mod tracker_credentials;
pub mod tracking;
pub mod v4;

pub async fn run_command_line() -> anyhow::Result<()> {
    lifecycle::run_command_line().await
}
