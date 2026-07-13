pub mod app;
pub mod autostart;
pub mod config;
pub mod db;
pub mod discovery;
pub mod lifecycle;
pub mod middleware;
pub mod models;
pub mod replay;
pub mod routes;
pub mod runtime_manifest;
pub mod suwayomi_process;
pub mod tls;

pub async fn run_command_line() -> anyhow::Result<()> {
    lifecycle::run_command_line().await
}
