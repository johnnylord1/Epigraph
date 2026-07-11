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
    let mut activity: Value =
        serde_json::from_str(&activity_json).map_err(|err| err.to_string())?;
    if let Some(object) = activity.as_object_mut() {
        if let Some(activity_type) = object.remove("activity_type") {
            object.insert("type".to_string(), activity_type);
        }
    }
    let payload = json!({
        "cmd": "SET_ACTIVITY",
        "args": {
            "pid": std::process::id(),
            "activity": activity,
        },
        "nonce": Uuid::new_v4().to_string(),
    });

    if let Err(err) = client.send(payload.clone(), 1) {
        client
            .reconnect()
            .map_err(|reconnect_err| reconnect_err.to_string())?;
        client.send(payload, 1).map_err(|_| err.to_string())?;
    }

    Ok(())
}
