#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[allow(dead_code)]
mod suwayomi_maintenance;
mod syncd;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    syncd::run_command_line().await
}
