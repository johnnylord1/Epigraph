mod syncd;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    syncd::run().await
}
