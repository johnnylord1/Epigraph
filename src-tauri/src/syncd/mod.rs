pub mod app;
pub mod config;
pub mod db;
pub mod discovery;
pub mod middleware;
pub mod models;
pub mod replay;
pub mod routes;
pub mod tls;

pub async fn run() -> anyhow::Result<()> {
    app::run().await
}
