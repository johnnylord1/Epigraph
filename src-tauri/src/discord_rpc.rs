use rpcdiscord::{DiscordIpc, DiscordIpcClient};
use serde_json::{json, Value};
use std::sync::LazyLock;
use tokio::sync::Mutex;
use uuid::Uuid;

static DISCORD_RPC_CLIENT: LazyLock<Mutex<Option<DiscordIpcClient>>> =
    LazyLock::new(Mutex::default);

fn close_client(client: &mut DiscordIpcClient) {
    let _ = client.clear_activity();
    let _ = client.close();
}

fn normalize_activity_json(activity_json: &str) -> Result<Value, String> {
    let mut activity: Value = serde_json::from_str(activity_json).map_err(|err| err.to_string())?;
    let object = activity
        .as_object_mut()
        .ok_or_else(|| "Discord activity payload must be a JSON object".to_string())?;
    if let Some(activity_type) = object.remove("activity_type") {
        object.insert("type".to_string(), activity_type);
    }
    Ok(activity)
}

#[tauri::command]
pub async fn discord_rpc_start(application_id: String) -> Result<(), String> {
    let mut guard = DISCORD_RPC_CLIENT.lock().await;

    if let Some(client) = guard.as_mut() {
        close_client(client);
    }
    *guard = None;

    let mut client = DiscordIpcClient::new(&application_id).map_err(|err| err.to_string())?;
    client.connect().map_err(|err| err.to_string())?;
    *guard = Some(client);

    Ok(())
}

#[tauri::command]
pub async fn discord_rpc_stop() -> Result<(), String> {
    let mut guard = DISCORD_RPC_CLIENT.lock().await;

    if let Some(client) = guard.as_mut() {
        close_client(client);
    }
    *guard = None;

    Ok(())
}

#[tauri::command]
pub async fn discord_rpc_clear_activity() -> Result<(), String> {
    let mut guard = DISCORD_RPC_CLIENT.lock().await;

    if let Some(client) = guard.as_mut() {
        client.clear_activity().map_err(|err| err.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn discord_rpc_set_activity(activity_json: String) -> Result<(), String> {
    let mut guard = DISCORD_RPC_CLIENT.lock().await;
    let client = guard
        .as_mut()
        .ok_or_else(|| "Discord RPC client is not connected".to_string())?;
    let activity = normalize_activity_json(&activity_json)?;
    let payload = json!({
        "cmd": "SET_ACTIVITY",
        "args": {
            "pid": std::process::id(),
            "activity": activity,
        },
        "nonce": Uuid::new_v4().to_string(),
    });

    if let Err(initial_error) = client.send(payload.clone(), 1) {
        client
            .reconnect()
            .map_err(|reconnect_err| reconnect_err.to_string())?;
        client.send(payload, 1).map_err(|retry_error| {
            format!(
                "Discord activity send failed after reconnect: {retry_error} (initial error: {initial_error})"
            )
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_plugin_activity_type_for_discord_ipc() {
        let activity = normalize_activity_json(r#"{"activity_type":3,"details":"Reading"}"#)
            .expect("activity should normalize");

        assert_eq!(activity.get("type"), Some(&json!(3)));
        assert!(activity.get("activity_type").is_none());
    }

    #[test]
    fn rejects_non_object_activity_payloads() {
        let error = normalize_activity_json("null").expect_err("null is not an activity");

        assert_eq!(error, "Discord activity payload must be a JSON object");
    }

    #[tokio::test]
    #[ignore = "requires a running Discord desktop client"]
    async fn live_discord_ipc_smoke() {
        // rpcdiscord uses blocking pipe reads without a cancellation API. Isolate
        // the live check so a silent client cannot hang the suite or retain IPC.
        const CHILD_ENV: &str = "EPIGRAPH_LIVE_DISCORD_TEST_CHILD";
        if std::env::var(CHILD_ENV).as_deref() != Ok("1") {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "discord_rpc::tests::live_discord_ipc_smoke",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD_ENV, "1")
                .spawn()
                .expect("The isolated Discord test should start");
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        assert!(status.success(), "The isolated Discord check failed");
                        return;
                    }
                    Ok(None) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    result => {
                        let _ = child.kill();
                        let _ = child.wait();
                        panic!("Discord did not finish within the deadline; its test connection was closed ({result:?})");
                    }
                }
            }
        }

        async fn receive_activity_response() -> Result<Value, String> {
            let mut guard = DISCORD_RPC_CLIENT.lock().await;
            let client = guard.as_mut().ok_or("Discord client missing")?;
            let (opcode, response) = client.recv().map_err(|error| error.to_string())?;
            if opcode != 1 || response["cmd"] != "SET_ACTIVITY" || response["evt"] == "ERROR" {
                // Do not log the full RPC response: it can contain account information.
                return Err("Discord did not acknowledge the activity command".to_string());
            }
            Ok(response["data"].clone())
        }

        let result: Result<(), String> = async {
            discord_rpc_start("1522314876649996368".to_string()).await?;
            discord_rpc_set_activity(
                json!({
                    "details": "Validating Epigraph Rich Presence",
                    "assets": {
                        "large_image": "aethon_icon",
                        "large_text": "Epigraph"
                    }
                })
                .to_string(),
            )
            .await?;
            let activity = receive_activity_response().await?;
            if activity["details"] != "Validating Epigraph Rich Presence" {
                return Err("Discord did not confirm the test activity".to_string());
            }
            discord_rpc_clear_activity().await?;
            if !receive_activity_response().await?.is_null() {
                return Err("Discord did not confirm activity removal".to_string());
            }
            Ok(())
        }
        .await;
        let stopped = discord_rpc_stop().await;
        result.expect("Discord should acknowledge publishing and clearing the activity");
        stopped.expect("Discord IPC should stop");
    }
}
