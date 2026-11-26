use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::header::{ACCEPT_ENCODING, CONTENT_ENCODING, ETAG, IF_NONE_MATCH};
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use axum::Extension;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;

use crate::syncd::app::build_router_for_tests;
use crate::syncd::config::SyncdConfig;
use crate::syncd::db;
use crate::syncd::discovery::{
    SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
    SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager,
};
use crate::syncd::lifecycle::{ShutdownCoordinator, ShutdownReason, ShutdownRequest};
use crate::syncd::middleware::{CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER};
use crate::syncd::models::{AppState, SharedAppState};
use crate::syncd::v4::{
    build_v4_router, V4LiveEvent, V4LiveEventKind, V4Runtime, V4_LIVE_CHANNEL_CAPACITY,
};
use crate::syncd::v4::hlc::{
    canonical_chapter_key, canonical_work_key, normalize_portable_url, Hlc,
};
use crate::syncd::v4::merge::{merge_record, StoredRecordState};
use tokio::sync::{broadcast, Mutex, RwLock};

async fn build_v4_test_env() -> (TempDir, SharedAppState, axum::Router, String, String) {
    let temp = TempDir::new().unwrap();
    let mut config = SyncdConfig::from_env();
    config.data_dir = temp.path().to_path_buf();
    config.db_path = temp.path().join("syncd.sqlite");

    let pool = db::connect(&config).await.unwrap();
    db::upsert_server_identity(&pool, &config, "v4-test-fingerprint")
        .await
        .unwrap();

    let advertised =
        crate::syncd::config::SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
    let descriptor = SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();
    let manager = SyncdDiscoveryProviderManager::from_config(&config).unwrap();
    let initial_status = manager.initial_status(&config, &advertised);

    let (change_sender, _) = broadcast::channel(128);
    let (pairing_status_sender, _) = broadcast::channel(32);

    let state = Arc::new(AppState {
        config: config.clone(),
        advertised_endpoint_resolver: advertised,
        discovery_descriptor_provider: descriptor,
        client_discovery_contract_provider: SyncdClientDiscoveryContractProvider::default(),
        client_discovery_guidance_provider: SyncdClientDiscoveryGuidanceProvider::default(),
        discovery_provider_manager: manager,
        discovery_provider_state: Arc::new(RwLock::new(initial_status)),
        discovery_provider_runtime: Arc::new(Mutex::new(None)),
        pool: pool.clone(),
        change_sender,
        pairing_status_sender,
        mutation_gate: Arc::new(Mutex::new(())),
        tls_cert_sha256: "v4-test-fingerprint".to_string(),
        device_presence: Default::default(),
    });

    let token_a = db::issue_local_authority_token(&pool, &config, "android-a", "profile-alpha")
        .await
        .unwrap()
        .access_token;
    let token_b = db::issue_local_authority_token(&pool, &config, "desktop-b", "profile-beta")
        .await
        .unwrap()
        .access_token;

    let router = build_router_for_tests(state.clone());
    (temp, state, router, token_a, token_b)
}

async fn v4_request(
    app: &axum::Router,
    method: Method,
    uri: &str,
    token: &str,
    body: Option<Value>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(CLIENT_VERSION_HEADER, "0.1.0")
        .header(CLIENT_PROTOCOL_HEADER, "4")
        .header("authorization", format!("Bearer {token}"));
    let body = match body {
        Some(v) => {
            builder = builder.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let resp = app
        .clone()
        .oneshot(builder.body(body).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json_val = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, headers, json_val)
}

#[test]
fn portable_url_normalization_strips_host_and_style_list_query() {
    let with_style =
        normalize_portable_url("https://toonily.com/webtoon/perfect-half/chapter-66/?style=list");
    let without_style = normalize_portable_url("/webtoon/perfect-half/chapter-66/");
    let alt_mirror = normalize_portable_url(
        "https://toonily.net/webtoon/perfect-half//chapter-66?utm_source=app&style=paged",
    );
    assert_eq!(with_style, "/webtoon/perfect-half/chapter-66");
    assert_eq!(with_style, without_style);
    assert_eq!(with_style, alt_mirror);

    // Significant query params remain sorted and intact.
    let significant = normalize_portable_url("https://example.org/read?b=2&style=list&a=1");
    assert_eq!(significant, "/read?a=1&b=2");

    let wk = canonical_work_key("12345", "https://toonily.com/webtoon/perfect-half/");
    let ck = canonical_chapter_key(
        &wk,
        "https://toonily.com/webtoon/perfect-half/ch-1/?style=list",
    );
    assert_eq!(wk, "12345:/webtoon/perfect-half");
    assert_eq!(ck, "12345:/webtoon/perfect-half|/webtoon/perfect-half/ch-1");
}

#[test]
fn offline_chapter_merge_unites_progress_and_respects_explicit_unread_reset() {
    let base = StoredRecordState {
        domain: "comics".into(),
        entity_type: "comic.chapter".into(),
        entity_key: "src:/work|/work/ch-1".into(),
        payload: json!({
            "isRead": false,
            "lastPageRead": 12,
            "isBookmarked": true,
            "bookmarkHlc": { "tsMs": 2000, "counter": 0, "deviceId": "pc" },
            "readAtMs": 1500
        }),
        deleted: false,
        hlc: Hlc::new(2000, 0, "pc"),
        origin_device_id: "pc".into(),
    };

    // Phone read further offline with a slightly earlier clock and unbookmarked default.
    let phone_offline = StoredRecordState {
        domain: "comics".into(),
        entity_type: "comic.chapter".into(),
        entity_key: "src:/work|/work/ch-1".into(),
        payload: json!({
            "isRead": true,
            "lastPageRead": 24,
            "isBookmarked": false,
            "bookmarkHlc": { "tsMs": 1000, "counter": 0, "deviceId": "phone" },
            "readAtMs": 1900
        }),
        deleted: false,
        hlc: Hlc::new(1900, 0, "phone"),
        origin_device_id: "phone".into(),
    };

    let merged = merge_record(Some(&base), phone_offline);
    assert!(merged.changed);
    // Preserves BOTH phone's completed read AND PC's newer bookmark!
    assert_eq!(merged.state.payload["isRead"], json!(true));
    assert_eq!(merged.state.payload["lastPageRead"], json!(24));
    assert_eq!(merged.state.payload["isBookmarked"], json!(true));

    // Now user explicitly marks chapter unread & resets page to 0 with a newer HLC.
    let explicit_unread = StoredRecordState {
        domain: "comics".into(),
        entity_type: "comic.chapter".into(),
        entity_key: "src:/work|/work/ch-1".into(),
        payload: json!({
            "isRead": false,
            "lastPageRead": 0,
            "explicitResetHlc": { "tsMs": 3000, "counter": 0, "deviceId": "phone" }
        }),
        deleted: false,
        hlc: Hlc::new(3000, 0, "phone"),
        origin_device_id: "phone".into(),
    };
    let after_reset = merge_record(Some(&merged.state), explicit_unread);
    assert!(after_reset.changed);
    assert_eq!(after_reset.state.payload["isRead"], json!(false));
    assert_eq!(after_reset.state.payload["lastPageRead"], json!(0));
    // Bookmark still survives unless explicitly cleared!
    assert_eq!(after_reset.state.payload["isBookmarked"], json!(true));
}

#[test]
fn progress_updates_preserve_the_independent_bookmark_clock() {
    let chapter = |time, device: &str, payload| StoredRecordState {
        domain: "comics".into(),
        entity_type: "comic.chapter".into(),
        entity_key: "src:/work|/work/ch-1".into(),
        payload,
        deleted: false,
        hlc: Hlc::new(time, 0, device),
        origin_device_id: device.into(),
    };
    let bookmarked = chapter(100, "pc", json!({"isBookmarked": true}));
    let progress = chapter(300, "pc", json!({"lastPageRead": 9}));
    let unbookmark = chapter(200, "phone", json!({"isBookmarked": false}));

    let after_progress = merge_record(Some(&bookmarked), progress.clone());
    let after_unbookmark = merge_record(Some(&after_progress.state), unbookmark.clone());
    assert_eq!(after_unbookmark.state.payload["isBookmarked"], json!(false));
    assert_eq!(after_unbookmark.state.payload["lastPageRead"], json!(9));

    let reversed = merge_record(Some(&bookmarked), unbookmark);
    let reversed = merge_record(Some(&reversed.state), progress);
    assert_eq!(after_unbookmark.state.payload, reversed.state.payload);
}

#[test]
fn unrelated_clock_updates_do_not_hide_earlier_field_edits() {
    let item = |stamp, payload| StoredRecordState {
        domain: "comics".to_owned(),
        entity_type: "comic.work".to_owned(),
        entity_key: "123:/work".to_owned(),
        payload,
        deleted: false,
        hlc: Hlc::new(stamp, 0, "phone"),
        origin_device_id: "phone".to_owned(),
    };
    let original = item(1, json!({"favorite": true, "author": "A"}));
    let later_title = item(3, json!({"title": "New title"}));
    let earlier_change = item(2, json!({"favorite": false, "author": null}));
    let left = merge_record(Some(&original), later_title.clone()).state;
    let left = merge_record(Some(&left), earlier_change.clone()).state;
    let right = merge_record(Some(&original), earlier_change).state;
    let right = merge_record(Some(&right), later_title).state;
    assert_eq!(left.payload, right.payload);
    assert_eq!(left.payload["favorite"], false);
    assert!(left.payload["author"].is_null());
}

#[test]
fn delayed_chapter_reset_keeps_only_progress_written_after_the_reset() {
    let item = |stamp, payload| StoredRecordState {
        domain: "comics".to_owned(),
        entity_type: "comic.chapter".to_owned(),
        entity_key: "123:/work|/chapter".to_owned(),
        payload,
        deleted: false,
        hlc: Hlc::new(stamp, 0, "phone"),
        origin_device_id: "phone".to_owned(),
    };
    let before = item(1, json!({"isRead": true, "lastPageRead": 18}));
    let after = item(3, json!({"lastPageRead": 2}));
    let bookmark = item(4, json!({"isBookmarked": true}));
    let reset = item(
        2,
        json!({
            "isRead": false,
            "lastPageRead": 0,
            "explicitResetHlc": {"tsMs": 2, "counter": 0, "deviceId": "phone"}
        }),
    );
    let merged = merge_record(Some(&before), after.clone()).state;
    let merged = merge_record(Some(&merged), bookmark.clone()).state;
    let merged = merge_record(Some(&merged), reset.clone()).state;
    let ordered = merge_record(Some(&before), reset).state;
    let ordered = merge_record(Some(&ordered), after).state;
    let ordered = merge_record(Some(&ordered), bookmark).state;
    assert_eq!(merged.payload, ordered.payload);
    assert_eq!(merged.payload["isRead"], false);
    assert_eq!(merged.payload["lastPageRead"], 2);
    assert_eq!(merged.payload["isBookmarked"], true);
}

#[tokio::test]
async fn final_non_comic_chunk_releases_the_accumulated_comic_restore() {
    let (_temp, state, app, token, _) = build_v4_test_env().await;
    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/sync/bulk",
        &token,
        Some(json!({"finalBatch":false,"items":[{
            "domain":"comics","entityType":"comic.work","entityKey":"123:/work",
            "hlc":{"tsMs":1,"deviceId":"phone"},"payload":{"title":"Example"}
        }]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let scheduled = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT next_attempt_ms FROM v4_comics_projection WHERE profile_id = 'profile-alpha'",
        )
        .fetch_one(&state.pool)
        .await
        .unwrap()
    };
    assert!(scheduled().await > db::now_ms());
    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/sync/bulk",
        &token,
        Some(json!({"finalBatch":true,"items":[{
            "domain":"novels","entityType":"novel.work","entityKey":"plugin:/novel",
            "hlc":{"tsMs":1,"deviceId":"phone"},"payload":{"title":"Novel"}
        }]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(scheduled().await <= db::now_ms());
}

#[tokio::test]
async fn conditional_bulk_refuses_to_seed_over_an_intervening_commit() {
    let (_temp, _state, app, token, _) = build_v4_test_env().await;
    let item = json!({
        "domain": "comics", "entityType": "comic.work", "entityKey": "123:/work",
        "hlc": {"tsMs":1,"counter":0,"deviceId":"phone"}, "payload":{"title":"Example"}
    });
    let (created, _, receipt) = v4_request(
        &app,
        Method::POST,
        "/v4/sync/bulk",
        &token,
        Some(json!({"expectedServerSeq":0,"items":[item.clone()]})),
    )
    .await;
    assert_eq!(created, StatusCode::OK);
    assert_eq!(receipt["acceptedCount"], 1);
    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/sync/bulk",
        &token,
        Some(json!({"expectedServerSeq":0,"items":[item]})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn v4_bulk_sync_snapshot_etag_304_pagination_and_profile_isolation() {
    let (_temp, _state, app, token_alpha, token_beta) = build_v4_test_env().await;

    // 1. Capabilities check
    let (status, _, caps) =
        v4_request(&app, Method::GET, "/v4/capabilities", &token_alpha, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(caps["protocolVersion"], json!(4));
    assert_eq!(caps["profileId"], json!("profile-alpha"));

    // 2. Bulk sync with 2 valid items + 1 invalid item (must NEVER drop valid items!)
    let now = db::now_ms();
    let (status, _, summary) = v4_request(
        &app,
        Method::POST,
        "/v4/sync/bulk",
        &token_alpha,
        Some(json!({
            "items": [
                {
                    "clientMutationId": "mut-1",
                    "domain": "comics",
                    "entityType": "comic.work",
                    "entityKey": "123:/manga/one",
                    "deleted": false,
                    "hlc": { "tsMs": now, "counter": 0, "deviceId": "android-a" },
                    "payload": { "title": "Manga One", "favorite": true }
                },
                {
                    "clientMutationId": "mut-bad",
                    "domain": "invalid-domain",
                    "entityType": "comic.work",
                    "entityKey": "bad",
                    "deleted": false,
                    "hlc": { "tsMs": now, "counter": 1, "deviceId": "android-a" },
                    "payload": {}
                },
                {
                    "clientMutationId": "mut-2",
                    "domain": "novels",
                    "entityType": "novel.chapter",
                    "entityKey": "p1:/novel/a|/novel/a/ch-1",
                    "deleted": false,
                    "hlc": { "tsMs": now, "counter": 2, "deviceId": "android-a" },
                    "payload": { "isRead": true, "progressPercent": 100.0 }
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(summary["acceptedCount"], json!(2));
    assert_eq!(summary["rejected"].as_array().unwrap().len(), 1);
    assert_eq!(summary["rejected"][0]["code"], json!("INVALID_DOMAIN"));

    // 3. Re-sending the exact same clientMutationId is deduplicated idempotently.
    let (status, _, dup) = v4_request(
        &app,
        Method::POST,
        "/v4/deltas",
        &token_alpha,
        Some(json!({
            "items": [
                {
                    "clientMutationId": "mut-1",
                    "domain": "comics",
                    "entityType": "comic.work",
                    "entityKey": "123:/manga/one",
                    "deleted": false,
                    "hlc": { "tsMs": now, "counter": 0, "deviceId": "android-a" },
                    "payload": { "title": "Manga One", "favorite": true }
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dup["deduplicatedCount"], json!(1));
    assert_eq!(dup["acceptedCount"], json!(0));

    // 4. Snapshot returns ETag, and conditional GET returns 304 Not Modified.
    let (status, headers, snap) =
        v4_request(&app, Method::GET, "/v4/snapshot", &token_alpha, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snap["recordCount"], json!(2));
    let etag = headers.get(ETAG).unwrap().to_str().unwrap().to_string();

    let req_304 = Request::builder()
        .method(Method::GET)
        .uri("/v4/snapshot")
        .header(CLIENT_VERSION_HEADER, "0.1.0")
        .header(CLIENT_PROTOCOL_HEADER, "4")
        .header("authorization", format!("Bearer {token_alpha}"))
        .header(IF_NONE_MATCH, etag)
        .body(Body::empty())
        .unwrap();
    let resp_304 = app.clone().oneshot(req_304).await.unwrap();
    assert_eq!(resp_304.status(), StatusCode::NOT_MODIFIED);

    // 5. Multi-profile isolation: profile-beta sees 0 records from profile-alpha!
    let (status, _, beta_snap) =
        v4_request(&app, Method::GET, "/v4/snapshot", &token_beta, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(beta_snap["profileId"], json!("profile-beta"));
    assert_eq!(beta_snap["recordCount"], json!(0));

    // 6. Paginated /v4/changes respects limit=1 and sets hasMore=true.
    let (status, _, page1) = v4_request(
        &app,
        Method::GET,
        "/v4/changes?sinceSeq=0&limit=1",
        &token_alpha,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page1["changes"].as_array().unwrap().len(), 1);
    assert_eq!(page1["hasMore"], json!(true));
    let next_seq = page1["nextSeq"].as_i64().unwrap();

    let (status, _, page2) = v4_request(
        &app,
        Method::GET,
        &format!("/v4/changes?sinceSeq={next_seq}&limit=10"),
        &token_alpha,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page2["changes"].as_array().unwrap().len(), 1);
    assert_eq!(page2["hasMore"], json!(false));
}

#[tokio::test]
async fn v4_projects_only_the_domains_granted_to_the_device() {
    let (_temp, state, app, token, _) = build_v4_test_env().await;
    let items = json!({"items":[
        {"domain":"comics","entityType":"comic.work","entityKey":"123:/a",
          "hlc":{"tsMs":1000,"deviceId":"android-a"},"payload":{"title":"Private comic"}},
        {"domain":"novels","entityType":"novel.work","entityKey":"plugin:/b",
          "hlc":{"tsMs":1000,"deviceId":"android-a"},"payload":{"title":"Granted novel"}}
    ]});
    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/sync/bulk",
        &token,
        Some(items.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    sqlx::query("DELETE FROM paired_device_scopes WHERE token_id = ? AND scope_id != ?")
        .bind("local-authority-android-a-profile-alpha")
        .bind("novels:profile:profile-alpha")
        .execute(&state.pool)
        .await
        .unwrap();

    let (status, _, snapshot) = v4_request(&app, Method::GET, "/v4/snapshot", &token, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["recordCount"], json!(1));
    assert_eq!(snapshot["records"][0]["entityType"], json!("novel.work"));
    let (status, _, _) = v4_request(
        &app,
        Method::GET,
        "/v4/snapshot?domain=comics",
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _, changes) = v4_request(
        &app,
        Method::GET,
        "/v4/changes?sinceSeq=0&limit=1",
        &token,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(changes["changes"], json!([]));
    assert_eq!(changes["nextSeq"], json!(1));
    assert_eq!(changes["hasMore"], json!(true));
    let (status, _, _) = v4_request(&app, Method::POST, "/v4/deltas", &token, Some(items)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let malformed = json!({"items":[{
        "domain":"novels", "entityType":"comic.work", "entityKey":"123:/a",
        "hlc":{"tsMs":2000,"deviceId":"android-a"}, "payload":{"title":"Invalid domain"}
    }]});
    let (status, _, response) =
        v4_request(&app, Method::POST, "/v4/deltas", &token, Some(malformed)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["rejected"][0]["code"], "INVALID_ENTITY_TYPE");
    assert_eq!(response["serverSeq"], snapshot["serverSeq"]);
}

#[tokio::test]
#[cfg(windows)]
async fn tracker_credentials_do_not_cross_profiles_on_either_protocol() {
    let (_temp, state, app, _, _) = build_v4_test_env().await;
    let issue = |profile: &'static str| {
        let state = state.clone();
        async move {
            db::issue_local_authority_token(&state.pool, &state.config, profile, profile)
                .await
                .unwrap()
                .access_token
        }
    };
    let main = issue("main").await;
    let other = issue("default").await;
    let (status, _, _) = v4_request(
        &app,
        Method::PUT,
        "/v4/tracker-credentials/anilist",
        &main,
        Some(json!({"baseRevision":0,"token":"test-only-token"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, other_v4) =
        v4_request(&app, Method::GET, "/v4/tracker-credentials", &other, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(other_v4["credentials"].as_array().unwrap().len(), 0);

    for (token, expected_count) in [(main, 1), (other, 0)] {
        let request = Request::get("/v1/tracker-credentials")
            .header(CLIENT_VERSION_HEADER, "0.1.0")
            .header(CLIENT_PROTOCOL_HEADER, "1")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let parsed: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            parsed["credentials"].as_array().unwrap().len(),
            expected_count
        );
    }
}

#[tokio::test]
async fn v4_real_android_comics_bulk_and_reconnect() {
    let Some(path) = std::env::var_os("EPIGRAPH_V4_BATCH_FIXTURE_DIR") else {
        return;
    };
    use std::collections::BTreeSet;
    use std::io::Write;

    let mut batches = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect::<Vec<_>>();
    batches.sort();
    assert!(!batches.is_empty());
    let (_temp, _state, app, token, _) = build_v4_test_env().await;
    let mut expected = BTreeSet::new();
    let mut upload_time = std::time::Duration::ZERO;
    for batch in batches {
        let raw = std::fs::read(batch).unwrap();
        let input: Value = serde_json::from_slice(&raw).unwrap();
        for item in input["items"].as_array().unwrap() {
            expected.insert((
                item["entityType"].as_str().unwrap().to_owned(),
                item["entityKey"].as_str().unwrap().to_owned(),
            ));
        }
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gzip.write_all(&raw).unwrap();
        let request = Request::post("/v4/sync/bulk")
            .header(CLIENT_VERSION_HEADER, "0.1.0")
            .header(CLIENT_PROTOCOL_HEADER, "4")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .header(CONTENT_ENCODING, "gzip")
            .body(Body::from(gzip.finish().unwrap()))
            .unwrap();
        let before = Instant::now();
        let response = app.clone().oneshot(request).await.unwrap();
        upload_time += before.elapsed();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let summary: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(summary["rejected"].as_array().unwrap().len(), 0);
    }
    assert!(expected.len() >= 30_000);
    let before = Instant::now();
    let (status, _, snapshot) = v4_request(&app, Method::GET, "/v4/snapshot", &token, None).await;
    let snapshot_time = before.elapsed();
    assert_eq!(status, StatusCode::OK);
    let records = snapshot["records"].as_array().unwrap();
    let found = records
        .iter()
        .map(|record| {
            (
                record["entityType"].as_str().unwrap().to_owned(),
                record["entityKey"].as_str().unwrap().to_owned(),
            )
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(found.len(), expected.len());
    assert!(
        found == expected,
        "Snapshot identities differ from the uploaded library"
    );
    if let Some(output) = std::env::var_os("EPIGRAPH_V4_SNAPSHOT_FIXTURE") {
        let file = std::fs::File::create(output).unwrap();
        serde_json::to_writer(std::io::BufWriter::new(file), &snapshot).unwrap();
    }
    let uri = format!("/v4/changes?sinceSeq={}", snapshot["serverSeq"]);
    let mut reconnect = Vec::with_capacity(30);
    for _ in 0..30 {
        let before = Instant::now();
        let (status, _, page) = v4_request(&app, Method::GET, &uri, &token, None).await;
        reconnect.push(before.elapsed());
        assert_eq!(status, StatusCode::OK);
        assert_eq!(page["changes"], json!([]));
        assert_eq!(page["nextSeq"], snapshot["serverSeq"]);
    }
    reconnect.sort();
    eprintln!("Real Android fixture: {} Core records, upload {upload_time:?}, snapshot {snapshot_time:?}, in-process reconnect p95 {:?}", found.len(), reconnect[28]);
}

#[tokio::test]
async fn v4_real_comic_snapshot_restores_into_suwayomi() {
    let (Some(snapshot), Ok(port)) = (
        std::env::var_os("EPIGRAPH_V4_SNAPSHOT_FIXTURE"),
        std::env::var("EPIGRAPH_V4_SUWAYOMI_TEST_PORT").and_then(|port| {
            port.parse::<u16>()
                .map_err(|_| std::env::VarError::NotPresent)
        }),
    ) else {
        return;
    };
    let input = std::fs::File::open(snapshot).unwrap();
    let snapshot: super::db::V4SnapshotResponse =
        serde_json::from_reader(std::io::BufReader::new(input)).unwrap();
    let (_temp, state, _, token, _) = build_v4_test_env().await;
    let session = crate::syncd::middleware::authenticate_token_public(&state, &token)
        .await
        .unwrap();
    state.config.set_suwayomi_proxy_test_upstream(
        &session.profile_id,
        &format!("http://127.0.0.1:{port}/"),
    );
    let counts = |entity_type: &str| {
        snapshot
            .records
            .iter()
            .filter(|record| record.entity_type == entity_type && !record.deleted)
            .count()
    };
    for records in snapshot.records.chunks(20_000) {
        let upload = records
            .iter()
            .map(|record| super::db::V4IncomingItem {
                client_mutation_id: None,
                domain: record.domain.clone(),
                entity_type: record.entity_type.clone(),
                entity_key: record.entity_key.clone(),
                deleted: record.deleted,
                hlc: record.hlc.clone(),
                payload: record.payload.clone(),
            })
            .collect();
        let receipt = super::db::apply_v4_batch(
            &state.pool,
            &session.profile_id,
            &session.device_id,
            upload,
            false,
        )
        .await
        .unwrap();
        assert!(receipt.rejected.is_empty());
    }
    sqlx::query("UPDATE v4_comics_projection SET next_attempt_ms = 0 WHERE profile_id = ?")
        .bind(&session.profile_id)
        .execute(&state.pool)
        .await
        .unwrap();
    let started = Instant::now();
    super::suwayomi::drain_projection_once(&state)
        .await
        .unwrap();
    let restore_time = started.elapsed();
    let (applied, target): (i64, i64) = sqlx::query_as(
        "SELECT applied_seq, target_seq FROM v4_comics_projection WHERE profile_id = ?",
    )
    .bind(&session.profile_id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        applied, target,
        "Projection must confirm the durable cursor"
    );
    let data = crate::syncd::routes::suwayomi_catalog::execute_graphql_document(
        &state,
        &session,
        r#"query EpigraphV4RestoredCounts {
            mangas(condition: { inLibrary: true }, first: 1) { totalCount }
            chapters(first: 1) { totalCount }
            trackRecords(first: 1) { totalCount }
            categories(first: 100) {
              nodes { name mangas { nodes { sourceId url } } }
            }
        }"#,
        json!({}),
        false,
    )
    .await
    .unwrap();
    for (entity, connection) in [
        ("comic.work", "mangas"),
        ("comic.chapter", "chapters"),
        ("comic.tracking", "trackRecords"),
    ] {
        let restored = data[connection]["totalCount"].as_u64().unwrap();
        eprintln!("{entity}: restored {restored}, expected {}", counts(entity));
        assert_eq!(restored, counts(entity) as u64, "Suwayomi {entity} count");
    }
    let categories = snapshot
        .records
        .iter()
        .filter(|record| record.entity_type == "comic.category" && !record.deleted)
        .map(|record| {
            (
                record.payload["name"].as_str().unwrap(),
                record.entity_key.as_str(),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    let mut restored_categories = std::collections::HashSet::new();
    let mut restored_assignments = std::collections::HashSet::new();
    for category in data["categories"]["nodes"].as_array().unwrap() {
        let name = category["name"].as_str().unwrap();
        let Some(key) = categories.get(name) else {
            continue;
        };
        restored_categories.insert(*key);
        for work in category["mangas"]["nodes"].as_array().unwrap() {
            let source_id = work["sourceId"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| work["sourceId"].to_string());
            let work_key = canonical_work_key(&source_id, work["url"].as_str().unwrap());
            restored_assignments.insert(format!("{work_key}|{key}"));
        }
    }
    assert_eq!(restored_categories.len(), counts("comic.category"));
    let expected_assignments = snapshot
        .records
        .iter()
        .filter(|record| record.entity_type == "comic.category_assignment" && !record.deleted)
        .map(|record| record.entity_key.clone())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(restored_assignments.len(), expected_assignments.len());
    assert!(
        restored_assignments == expected_assignments,
        "Suwayomi category memberships"
    );
    eprintln!("V4 real comics applied to Suwayomi in {restore_time:?}");
}

#[tokio::test]
async fn v4_bulk_35k_records_commits_fast_and_serves_gzipped_snapshot() {
    let (_temp, state, app, token_alpha, _) = build_v4_test_env().await;

    // Simulate a real large library: 700 comics + 30,600 chapters + 3,700 novel chapters = 35,000 items.
    let now = db::now_ms();
    let mut items = Vec::with_capacity(35_000);
    for w in 0..700 {
        items.push(crate::syncd::v4::db::V4IncomingItem {
            client_mutation_id: None,
            domain: "comics".to_string(),
            entity_type: "comic.work".to_string(),
            entity_key: format!("src1:/manga/work-{w}"),
            deleted: false,
            hlc: Hlc::new(now, w as i64, "android-a"),
            payload: json!({ "title": format!("Comic {w}"), "favorite": true }),
        });
    }
    for c in 0..34_300 {
        let w = c % 700;
        items.push(crate::syncd::v4::db::V4IncomingItem {
            client_mutation_id: None,
            domain: if c < 30_600 { "comics" } else { "novels" }.to_string(),
            entity_type: if c < 30_600 {
                "comic.chapter"
            } else {
                "novel.chapter"
            }
            .to_string(),
            entity_key: format!("src1:/manga/work-{w}|/manga/work-{w}/ch-{c}"),
            deleted: false,
            hlc: Hlc::new(now, (700 + c) as i64, "android-a"),
            payload: json!({ "isRead": true, "lastPageRead": 18, "isBookmarked": false }),
        });
    }

    let started = Instant::now();
    let summary = crate::syncd::v4::db::apply_v4_batch(
        &state.pool,
        "profile-alpha",
        "android-a",
        items,
        false,
    )
    .await
    .unwrap();
    let elapsed = started.elapsed();
    eprintln!("Synthetic V4 bulk commit (35,000 records): {elapsed:?}");

    assert_eq!(summary.accepted_count, 35_000);
    assert!(summary.rejected.is_empty());
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "35k V4 bulk commit took too long: {elapsed:?}"
    );

    // Fetch snapshot with gzip compression enabled and verify it compresses tightly.
    let req = Request::builder()
        .method(Method::GET)
        .uri("/v4/snapshot")
        .header(CLIENT_VERSION_HEADER, "0.1.0")
        .header(CLIENT_PROTOCOL_HEADER, "4")
        .header("authorization", format!("Bearer {token_alpha}"))
        .header(ACCEPT_ENCODING, "gzip")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers()
            .get(CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok()),
        Some("gzip")
    );
    let gz_bytes = resp.into_body().collect().await.unwrap().to_bytes();
    // 35,000 JSON records must compress down to < 2.5 MB over LAN!
    assert!(
        gz_bytes.len() < 2_500_000,
        "Expected compact gzipped 35k snapshot (<2.5 MB), got {} bytes",
        gz_bytes.len()
    );
}

#[tokio::test]
async fn v4_extension_package_lan_cache_roundtrip() {
    let (_temp, _state, app, token_alpha, _) = build_v4_test_env().await;

    let payload_bytes = b"export default { id: 'novel-test', version: '1.2.3' };".to_vec();

    // HEAD before upload -> 404
    let req_head_missing = Request::builder()
        .method(Method::HEAD)
        .uri("/v4/extensions/packages/novel/novel-test/1.2.3")
        .header(CLIENT_VERSION_HEADER, "0.1.0")
        .header(CLIENT_PROTOCOL_HEADER, "4")
        .header("authorization", format!("Bearer {token_alpha}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone()
            .oneshot(req_head_missing)
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );

    // PUT package
    let req_put = Request::builder()
        .method(Method::PUT)
        .uri("/v4/extensions/packages/novel/novel-test/1.2.3")
        .header(CLIENT_VERSION_HEADER, "0.1.0")
        .header(CLIENT_PROTOCOL_HEADER, "4")
        .header("authorization", format!("Bearer {token_alpha}"))
        .header("content-type", "application/javascript")
        .body(Body::from(payload_bytes.clone()))
        .unwrap();
    let put_resp = app.clone().oneshot(req_put).await.unwrap();
    assert_eq!(put_resp.status(), StatusCode::OK);

    // GET package returns exact bytes
    let req_get = Request::builder()
        .method(Method::GET)
        .uri("/v4/extensions/packages/novel/novel-test/1.2.3")
        .header(CLIENT_VERSION_HEADER, "0.1.0")
        .header(CLIENT_PROTOCOL_HEADER, "4")
        .header("authorization", format!("Bearer {token_alpha}"))
        .body(Body::empty())
        .unwrap();
    let get_resp = app.clone().oneshot(req_get).await.unwrap();
    assert_eq!(get_resp.status(), StatusCode::OK);
    let got_bytes = get_resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(got_bytes.as_ref(), payload_bytes.as_slice());
}

#[tokio::test]
async fn bootstrap_session_creation_rejects_non_loopback_lan_callers() {
    let (_temp, _state, app, _, _) = build_v4_test_env().await;

    // Non-loopback LAN IP must be rejected with 403 Forbidden.
    let lan_req = Request::builder()
        .method(Method::POST)
        .uri("/v1/bootstrap/session")
        .header("content-type", "application/json")
        .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [192, 168, 1, 55],
            51234,
        ))))
        .body(Body::from(json!({ "profileId": "main" }).to_string()))
        .unwrap();
    let lan_resp = app.clone().oneshot(lan_req).await.unwrap();
    assert_eq!(lan_resp.status(), StatusCode::FORBIDDEN);

    // Loopback succeeds.
    let local_req = Request::builder()
        .method(Method::POST)
        .uri("/v1/bootstrap/session")
        .header("content-type", "application/json")
        .extension(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            51234,
        ))))
        .body(Body::from(json!({ "profileId": "main" }).to_string()))
        .unwrap();
    let local_resp = app.clone().oneshot(local_req).await.unwrap();
    assert_eq!(local_resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn marco4_multi_profile_isolation_across_all_v4_endpoints() {
    let (_temp, state, app, _, _) = build_v4_test_env().await;
    let token_main = db::issue_local_authority_token(&state.pool, &state.config, "phone-main", "main")
        .await
        .unwrap()
        .access_token;
    let token_secondary = db::issue_local_authority_token(
        &state.pool,
        &state.config,
        "phone-secondary",
        "secondary",
    )
    .await
    .unwrap()
    .access_token;

    let now = db::now_ms();

    // 1. /v4/sync/bulk on both profiles
    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/sync/bulk",
        &token_main,
        Some(json!({
            "items": [{
                "clientMutationId": "mut-main-1",
                "domain": "books",
                "entityType": "book.work",
                "entityKey": "book-main-1",
                "hlc": { "tsMs": now, "counter": 0, "deviceId": "phone-main" },
                "deleted": false,
                "payload": { "title": "Main Book", "progress": 0.25 }
            }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/sync/bulk",
        &token_secondary,
        Some(json!({
            "items": [{
                "clientMutationId": "mut-sec-1",
                "domain": "books",
                "entityType": "book.work",
                "entityKey": "book-sec-1",
                "hlc": { "tsMs": now + 1, "counter": 0, "deviceId": "phone-secondary" },
                "deleted": false,
                "payload": { "title": "Secondary Book", "progress": 0.75 }
            }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 2. /v4/deltas on both profiles
    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/deltas",
        &token_main,
        Some(json!({
            "items": [{
                "clientMutationId": "mut-main-2",
                "domain": "books",
                "entityType": "book.work",
                "entityKey": "book-main-2",
                "hlc": { "tsMs": now + 2, "counter": 0, "deviceId": "phone-main" },
                "deleted": false,
                "payload": { "title": "Main Delta Book" }
            }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/deltas",
        &token_secondary,
        Some(json!({
            "items": [{
                "clientMutationId": "mut-sec-2",
                "domain": "books",
                "entityType": "book.work",
                "entityKey": "book-sec-2",
                "hlc": { "tsMs": now + 3, "counter": 0, "deviceId": "phone-secondary" },
                "deleted": false,
                "payload": { "title": "Secondary Delta Book" }
            }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 3. /v4/tracker-credentials on both profiles
    let (status, _, _) = v4_request(
        &app,
        Method::PUT,
        "/v4/tracker-credentials/anilist",
        &token_main,
        Some(json!({
            "baseRevision": 0,
            "token": "main-secret-token",
            "username": "main-user"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = v4_request(
        &app,
        Method::PUT,
        "/v4/tracker-credentials/myanimelist",
        &token_secondary,
        Some(json!({
            "baseRevision": 0,
            "token": "sec-secret-token",
            "username": "sec-user"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 4. Verify /v4/snapshot isolation
    let (status, _, main_snap) =
        v4_request(&app, Method::GET, "/v4/snapshot", &token_main, None).await;
    assert_eq!(status, StatusCode::OK);
    let main_ids: Vec<&str> = main_snap["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["entityKey"].as_str().unwrap())
        .collect();
    assert!(main_ids.contains(&"book-main-1"));
    assert!(main_ids.contains(&"book-main-2"));
    assert!(!main_ids.iter().any(|id| id.contains("sec")));

    let (status, _, sec_snap) =
        v4_request(&app, Method::GET, "/v4/snapshot", &token_secondary, None).await;
    assert_eq!(status, StatusCode::OK);
    let sec_ids: Vec<&str> = sec_snap["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["entityKey"].as_str().unwrap())
        .collect();
    assert!(sec_ids.contains(&"book-sec-1"));
    assert!(sec_ids.contains(&"book-sec-2"));
    assert!(!sec_ids.iter().any(|id| id.contains("main")));

    // 5. Verify /v4/changes isolation
    let (status, _, main_changes) =
        v4_request(&app, Method::GET, "/v4/changes?sinceSeq=0", &token_main, None).await;
    assert_eq!(status, StatusCode::OK);
    for item in main_changes["changes"].as_array().unwrap() {
        assert!(!item["entityKey"].as_str().unwrap().contains("sec"));
    }

    // 6. Verify /v4/tracker-credentials isolation
    let (status, _, main_creds) =
        v4_request(&app, Method::GET, "/v4/tracker-credentials", &token_main, None).await;
    assert_eq!(status, StatusCode::OK);
    let main_creds_str = main_creds.to_string();
    assert!(main_creds_str.contains("anilist"));
    assert!(!main_creds_str.contains("myanimelist"));
    assert!(!main_creds_str.contains("sec-user"));

    let (status, _, sec_creds) = v4_request(
        &app,
        Method::GET,
        "/v4/tracker-credentials",
        &token_secondary,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let sec_creds_str = sec_creds.to_string();
    assert!(sec_creds_str.contains("myanimelist"));
    assert!(!sec_creds_str.contains("anilist"));
    assert!(!sec_creds_str.contains("main-user"));
}

#[tokio::test]
async fn marco4_extended_offline_divergence_and_merge() {
    let (_temp, state, app, token_phone, _) = build_v4_test_env().await;
    let token_desktop =
        db::issue_local_authority_token(&state.pool, &state.config, "desktop-a", "profile-alpha")
            .await
            .unwrap()
            .access_token;
    let _ = token_desktop.clone();

    let now = db::now_ms();

    // Seed initial library: book-a, book-b (bound), book-c
    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/sync/bulk",
        &token_phone,
        Some(json!({
            "items": [
                {
                    "clientMutationId": "seed-a",
                    "domain": "books",
                    "entityType": "book.work",
                    "entityKey": "book-a",
                    "hlc": { "tsMs": now, "counter": 0, "deviceId": "phone" },
                    "deleted": false,
                    "payload": { "title": "Book A", "chapter": 1 }
                },
                {
                    "clientMutationId": "seed-b",
                    "domain": "books",
                    "entityType": "book.work",
                    "entityKey": "book-b",
                    "hlc": { "tsMs": now, "counter": 1, "deviceId": "phone" },
                    "deleted": false,
                    "payload": { "title": "Book B", "chapter": 3 }
                },
                {
                    "clientMutationId": "seed-c",
                    "domain": "books",
                    "entityType": "book.work",
                    "entityKey": "book-c",
                    "hlc": { "tsMs": now, "counter": 2, "deviceId": "phone" },
                    "deleted": false,
                    "payload": { "title": "Book C", "chapter": 2 }
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Phone offline: reads chapters on book-a, adds bookmark on book-a, deletes book-b
    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/deltas",
        &token_phone,
        Some(json!({
            "items": [
                {
                    "clientMutationId": "phone-a",
                    "domain": "books",
                    "entityType": "book.work",
                    "entityKey": "book-a",
                    "hlc": { "tsMs": now + 10, "counter": 0, "deviceId": "phone" },
                    "deleted": false,
                    "payload": { "title": "Book A", "chapter": 12 }
                },
                {
                    "clientMutationId": "phone-bm",
                    "domain": "books",
                    "entityType": "book.bookmark",
                    "entityKey": "bookmark-a-1",
                    "hlc": { "tsMs": now + 11, "counter": 0, "deviceId": "phone" },
                    "deleted": false,
                    "payload": { "bookId": "book-a", "page": 42 }
                },
                {
                    "clientMutationId": "phone-del-b",
                    "domain": "books",
                    "entityType": "book.work",
                    "entityKey": "book-b",
                    "hlc": { "tsMs": now + 12, "counter": 0, "deviceId": "phone" },
                    "deleted": true,
                    "payload": null
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Desktop concurrently: reads chapters on book-c, edits book-c
    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/deltas",
        &token_desktop,
        Some(json!({
            "items": [
                {
                    "clientMutationId": "desktop-c",
                    "domain": "books",
                    "entityType": "book.work",
                    "entityKey": "book-c",
                    "hlc": { "tsMs": now + 15, "counter": 0, "deviceId": "desktop" },
                    "deleted": false,
                    "payload": { "title": "Book C (Edited)", "chapter": 9 }
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Both devices fetch /v4/snapshot -> verify convergence, 0 progress loss, 0 duplicates, 0 resurrection
    let (status_p, _, snap_phone) =
        v4_request(&app, Method::GET, "/v4/snapshot", &token_phone, None).await;
    let (status_d, _, snap_desktop) =
        v4_request(&app, Method::GET, "/v4/snapshot", &token_desktop, None).await;
    assert_eq!(status_p, StatusCode::OK);
    assert_eq!(status_d, StatusCode::OK);
    assert_eq!(snap_phone["records"], snap_desktop["records"]);

    let records = snap_phone["records"].as_array().unwrap();
    assert_eq!(records.len(), 4); // book-a, book-b (tombstone), book-c, bookmark-a-1

    let book_a = records.iter().find(|r| r["entityKey"] == "book-a").unwrap();
    assert_eq!(book_a["payload"]["chapter"], 12);
    assert_eq!(book_a["deleted"], false);

    let bookmark = records
        .iter()
        .find(|r| r["entityKey"] == "bookmark-a-1")
        .unwrap();
    assert_eq!(bookmark["payload"]["page"], 42);

    let book_b = records.iter().find(|r| r["entityKey"] == "book-b").unwrap();
    assert_eq!(book_b["deleted"], true);

    let book_c = records.iter().find(|r| r["entityKey"] == "book-c").unwrap();
    assert_eq!(book_c["payload"]["chapter"], 9);
    assert_eq!(book_c["payload"]["title"], "Book C (Edited)");
}

#[tokio::test]
async fn marco4_thirty_consecutive_empty_reconnects_under_500ms_p95() {
    let (_temp, _state, app, token_a, _) = build_v4_test_env().await;

    let now = db::now_ms();
    let (status, _, _) = v4_request(
        &app,
        Method::POST,
        "/v4/sync/bulk",
        &token_a,
        Some(json!({
            "items": [{
                "clientMutationId": "idle-1",
                "domain": "books",
                "entityType": "book.work",
                "entityKey": "book-1",
                "hlc": { "tsMs": now, "counter": 0, "deviceId": "a" },
                "deleted": false,
                "payload": { "title": "Idle Book" }
            }]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, headers, snap) =
        v4_request(&app, Method::GET, "/v4/snapshot", &token_a, None).await;
    assert_eq!(status, StatusCode::OK);
    let etag = headers.get("etag").unwrap().to_str().unwrap().to_string();
    let current_seq = snap["serverSeq"].as_i64().unwrap();

    let mut latencies_ms = Vec::with_capacity(30);
    for _ in 0..30 {
        let start = std::time::Instant::now();

        let (c_status, _, c_body) = v4_request(
            &app,
            Method::GET,
            &format!("/v4/changes?sinceSeq={current_seq}"),
            &token_a,
            None,
        )
        .await;
        assert_eq!(c_status, StatusCode::OK);
        assert_eq!(c_body["hasMore"], false);
        assert!(c_body["changes"].as_array().unwrap().is_empty());

        let req = Request::builder()
            .method(Method::GET)
            .uri("/v4/snapshot")
            .header(CLIENT_VERSION_HEADER, "0.1.0")
            .header(CLIENT_PROTOCOL_HEADER, "4")
            .header("authorization", format!("Bearer {token_a}"))
            .header("if-none-match", etag.as_str())
            .body(Body::empty())
            .unwrap();
        let s_resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(s_resp.status(), StatusCode::NOT_MODIFIED);

        latencies_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    latencies_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p95_idx = ((latencies_ms.len() as f64) * 0.95).ceil() as usize - 1;
    let p95_ms = latencies_ms[p95_idx.min(latencies_ms.len() - 1)];
    eprintln!("marco4_30_empty_reconnects_p95_ms={p95_ms:.3}");
    assert!(
        p95_ms < 500.0,
        "p95 empty reconnect latency {p95_ms:.3}ms exceeded 500ms"
    );
}

// --- Ported lifecycle / security guarantees for the V4 SSE stream, bulk gzip and asset scopes ---

const STREAM_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Builds the V4 router with the shutdown coordinator and live runtime exposed, which
/// `build_v4_test_env` hides. The stream tests need both to drive shutdown and live events.
async fn build_v4_stream_app(
    state: &SharedAppState,
) -> (axum::Router, Arc<V4Runtime>, ShutdownCoordinator) {
    let (shutdown, _rx) = ShutdownCoordinator::channel();
    let runtime = Arc::new(V4Runtime::new());
    let app = build_v4_router(state.clone(), runtime.clone())
        .layer(Extension(shutdown.clone()))
        .with_state(state.clone());
    (app, runtime, shutdown)
}

fn sse_request(uri: &str, token: &str, last_event_id: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .header(CLIENT_VERSION_HEADER, "0.1.0")
        .header(CLIENT_PROTOCOL_HEADER, "4")
        .header("authorization", format!("Bearer {token}"))
        .header("accept", "text/event-stream");
    if let Some(id) = last_event_id {
        builder = builder.header("last-event-id", id);
    }
    builder.body(Body::empty()).unwrap()
}

/// Reads SSE frames until `marker` appears; panics if it does not arrive within `STREAM_WAIT`.
async fn read_sse_until(body: &mut Body, marker: &str) -> String {
    tokio::time::timeout(STREAM_WAIT, async {
        let mut seen = String::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.expect("SSE frame");
            if let Some(data) = frame.data_ref() {
                seen.push_str(&String::from_utf8_lossy(data));
                if seen.contains(marker) {
                    return seen;
                }
            }
        }
        panic!("SSE stream ended before `{marker}` was seen; got: {seen}");
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for `{marker}` on the SSE stream"))
}

/// Drains the SSE body and reports whether it ended (server closed the stream) in time.
async fn sse_stream_ends(body: &mut Body) -> bool {
    tokio::time::timeout(STREAM_WAIT, async {
        while let Some(frame) = body.frame().await {
            if frame.is_err() {
                return false;
            }
        }
        true
    })
    .await
    .unwrap_or(false)
}

async fn v4_raw(
    app: &axum::Router,
    method: Method,
    uri: &str,
    token: &str,
    body: Body,
) -> (StatusCode, Vec<u8>) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header(CLIENT_VERSION_HEADER, "0.1.0")
        .header(CLIENT_PROTOCOL_HEADER, "4")
        .header("authorization", format!("Bearer {token}"))
        .body(body)
        .unwrap();
    let resp = app.clone().oneshot(request).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec())
}

fn stream_shutdown_request() -> ShutdownRequest {
    ShutdownRequest {
        run_id: "v4-test-run".to_owned(),
        nonce: "v4-test-nonce".to_owned(),
        server_id: "v4-test-fingerprint".to_owned(),
        expected_pid: std::process::id(),
        reason: ShutdownReason::Manual,
        unless_devices_connected: false,
    }
}

async fn seed_one_comic_change(app: &axum::Router, token: &str) {
    let (status, _, summary) = v4_request(
        app,
        Method::POST,
        "/v4/sync/bulk",
        token,
        Some(json!({"items":[{
            "domain":"comics","entityType":"comic.work","entityKey":"123:/work",
            "hlc":{"tsMs":1000,"deviceId":"android-a"},"payload":{"title":"Seed"}
        }]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(summary["acceptedCount"], 1);
}

#[tokio::test]
async fn v4_events_stream_ends_when_shutdown_is_requested() {
    let (_temp, state, _, token_a, _) = build_v4_test_env().await;
    let (app, _runtime, shutdown) = build_v4_stream_app(&state).await;
    let resp = app
        .clone()
        .oneshot(sse_request("/v4/events", &token_a, None))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let mut body = resp.into_body();
    read_sse_until(&mut body, "event: hello").await;

    assert!(shutdown.request(stream_shutdown_request()));
    assert!(sse_stream_ends(&mut body).await, "stream stayed open after shutdown");
}

#[tokio::test]
async fn v4_events_lagged_receiver_is_told_to_catch_up() {
    let (_temp, state, _, token_a, _) = build_v4_test_env().await;
    let (app, runtime, _shutdown) = build_v4_stream_app(&state).await;
    let resp = app
        .clone()
        .oneshot(sse_request("/v4/events", &token_a, None))
        .await
        .unwrap();
    let mut body = resp.into_body();

    // Overflow the live channel before the stream is polled, so its receiver lags.
    for seq in 1..=(V4_LIVE_CHANNEL_CAPACITY as i64 + 64) {
        let _ = runtime.live_sender.send(V4LiveEvent {
            profile_id: "profile-alpha".to_owned(),
            origin_device_id: "desktop-b".to_owned(),
            server_seq: seq,
            kind: V4LiveEventKind::BulkCommitted {
                record_count: 0,
                server_seq: seq,
                server_time_ms: 0,
            },
        });
    }
    let seen = read_sse_until(&mut body, "event: catchup_required").await;
    assert!(seen.contains("\"skipped\""), "catchup_required lacks skipped count: {seen}");
}

#[tokio::test]
async fn v4_events_backlog_replays_from_last_event_id_and_skips_own_device_by_default() {
    let (_temp, state, app, token_a, _) = build_v4_test_env().await;
    seed_one_comic_change(&app, &token_a).await;
    let token_c = db::issue_local_authority_token(&state.pool, &state.config, "phone-c", "profile-alpha")
        .await
        .unwrap()
        .access_token;
    let (stream_app, _runtime, _shutdown) = build_v4_stream_app(&state).await;

    // Another device on the same profile replays the missed change from Last-Event-ID.
    let resp = stream_app
        .clone()
        .oneshot(sse_request("/v4/events", &token_c, Some("0")))
        .await
        .unwrap();
    let mut other_body = resp.into_body();
    let replay = read_sse_until(&mut other_body, "event: delta").await;
    assert!(replay.contains("\"entityKey\":\"123:/work\""), "backlog delta: {replay}");

    // The originating device does not get its own change back unless includeOwn=true.
    let resp = stream_app
        .clone()
        .oneshot(sse_request("/v4/events", &token_a, Some("0")))
        .await
        .unwrap();
    let mut own_body = resp.into_body();
    let own = read_sse_until(&mut own_body, "event: clock").await;
    assert!(!own.contains("event: delta"), "own change echoed without includeOwn: {own}");
}

#[tokio::test]
async fn v4_changes_and_events_refuse_a_cursor_ahead_of_the_server() {
    let (_temp, state, app, token_a, _) = build_v4_test_env().await;
    let (status, _, body) =
        v4_request(&app, Method::GET, "/v4/changes?sinceSeq=999", &token_a, None).await;
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(body["error"]["code"], "CURSOR_AHEAD_OF_SERVER");
    assert_eq!(body["error"]["requiredAction"], "snapshot_merge");

    let (stream_app, _runtime, _shutdown) = build_v4_stream_app(&state).await;
    let resp = stream_app
        .clone()
        .oneshot(sse_request("/v4/events?sinceSeq=999", &token_a, None))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::GONE);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"]["code"], "CURSOR_AHEAD_OF_SERVER");
    assert_eq!(body["error"]["requiredAction"], "snapshot_merge");
}

#[tokio::test]
async fn v4_replay_window_expiry_requires_a_snapshot_merge() {
    let (_temp, state, app, token_a, _) = build_v4_test_env().await;
    seed_one_comic_change(&app, &token_a).await;
    sqlx::query("UPDATE v4_profile_watermarks SET min_replayable_seq = 1 WHERE profile_id = ?")
        .bind("profile-alpha")
        .execute(&state.pool)
        .await
        .unwrap();

    let (status, _, body) =
        v4_request(&app, Method::GET, "/v4/changes?sinceSeq=0", &token_a, None).await;
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(body["error"]["code"], "REPLAY_WINDOW_EXPIRED");
    assert_eq!(body["error"]["requiredAction"], "snapshot_merge");
    assert_eq!(body["error"]["minReplayableServerVersion"], 1);

    let (stream_app, _runtime, _shutdown) = build_v4_stream_app(&state).await;
    let resp = stream_app
        .clone()
        .oneshot(sse_request("/v4/events?sinceSeq=0", &token_a, None))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::GONE);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"]["code"], "REPLAY_WINDOW_EXPIRED");
}

#[tokio::test]
async fn v4_events_stream_closes_after_token_revocation() {
    let (_temp, state, _, token_a, _) = build_v4_test_env().await;
    let (app, _runtime, _shutdown) = build_v4_stream_app(&state).await;
    let resp = app
        .clone()
        .oneshot(sse_request("/v4/events", &token_a, None))
        .await
        .unwrap();
    let mut body = resp.into_body();
    read_sse_until(&mut body, "event: hello").await;

    db::revoke_token(&state.pool, &db::hash_token(&token_a))
        .await
        .unwrap();
    assert!(sse_stream_ends(&mut body).await, "revoked token kept streaming");
}

#[tokio::test]
async fn v4_events_stream_closes_when_its_scope_is_removed() {
    let (_temp, state, _, token_a, _) = build_v4_test_env().await;
    let (app, _runtime, _shutdown) = build_v4_stream_app(&state).await;
    let resp = app
        .clone()
        .oneshot(sse_request("/v4/events", &token_a, None))
        .await
        .unwrap();
    let mut body = resp.into_body();
    read_sse_until(&mut body, "event: hello").await;

    sqlx::query("DELETE FROM paired_device_scopes WHERE token_id = ? AND scope_id != ?")
        .bind("local-authority-android-a-profile-alpha")
        .bind("novels:profile:profile-alpha")
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(sse_stream_ends(&mut body).await, "stream kept running after scope removal");
}

#[tokio::test]
async fn v4_active_stream_extends_the_device_inactivity_window() {
    let (_temp, state, _, token_a, _) = build_v4_test_env().await;
    let (app, _runtime, _shutdown) = build_v4_stream_app(&state).await;
    let resp = app
        .clone()
        .oneshot(sse_request("/v4/events", &token_a, None))
        .await
        .unwrap();
    // The tick only extends a window in its second half (before window/2 remains), so place the
    // expiry one hour out and reset activity after the request authenticated. Only the stream's
    // clock tick can then move both fields. The tick starts once the body is polled below.
    let early_expiry = db::now_ms() + 60 * 60 * 1000;
    sqlx::query(
        "UPDATE paired_device_tokens SET last_seen_at_ms = 0, inactivity_expires_at_ms = ? WHERE token_id = ?",
    )
    .bind(early_expiry)
    .bind("local-authority-android-a-profile-alpha")
    .execute(&state.pool)
    .await
    .unwrap();
    let mut body = resp.into_body();
    read_sse_until(&mut body, "event: clock").await;

    let (last_seen, expires): (i64, i64) = sqlx::query_as(
        "SELECT last_seen_at_ms, inactivity_expires_at_ms FROM paired_device_tokens WHERE token_id = ?",
    )
    .bind("local-authority-android-a-profile-alpha")
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert!(last_seen > 0, "clock tick did not record device activity");
    assert!(expires > early_expiry, "clock tick did not extend the inactivity window");
}

#[tokio::test]
async fn v4_sync_bulk_rejects_corrupt_gzip_and_accepts_large_inflated_bodies() {
    let (_temp, _state, app, token_a, _) = build_v4_test_env().await;

    let (status, _) = {
        let request = Request::post("/v4/sync/bulk")
            .header(CLIENT_VERSION_HEADER, "0.1.0")
            .header(CLIENT_PROTOCOL_HEADER, "4")
            .header("authorization", format!("Bearer {token_a}"))
            .header("content-type", "application/json")
            .header(CONTENT_ENCODING, "gzip")
            .body(Body::from(b"this is not gzip".to_vec()))
            .unwrap();
        let resp = app.clone().oneshot(request).await.unwrap();
        let status = resp.status();
        (status, resp.into_body().collect().await.unwrap().to_bytes())
    };
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A valid gzip body whose inflated JSON is over 2 MiB still commits.
    let big_title = "x".repeat(2 * 1024 * 1024 + 1024);
    let raw = json!({"items":[{
        "domain":"comics","entityType":"comic.work","entityKey":"123:/big",
        "hlc":{"tsMs":1,"deviceId":"android-a"},"payload":{"title":big_title}
    }]})
    .to_string();
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    std::io::Write::write_all(&mut gzip, raw.as_bytes()).unwrap();
    let request = Request::post("/v4/sync/bulk")
        .header(CLIENT_VERSION_HEADER, "0.1.0")
        .header(CLIENT_PROTOCOL_HEADER, "4")
        .header("authorization", format!("Bearer {token_a}"))
        .header("content-type", "application/json")
        .header(CONTENT_ENCODING, "gzip")
        .body(Body::from(gzip.finish().unwrap()))
        .unwrap();
    let resp = app.clone().oneshot(request).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let summary: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(summary["acceptedCount"], 1);
}

#[tokio::test]
async fn v4_asset_blob_is_only_served_within_the_scope_it_was_stored_in() {
    let (_temp, _state, app, token_a, token_b) = build_v4_test_env().await;
    let bytes = b"epigraph v4 asset scope check".to_vec();
    let sha = format!("{:x}", Sha256::digest(&bytes));
    let books = "books:global";
    let novels = "novels:profile:profile-alpha";

    let (status, _) = v4_raw(
        &app,
        Method::PUT,
        &format!("/v4/assets/{sha}?scopeId={books}"),
        &token_a,
        Body::from(bytes.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, served) = v4_raw(
        &app,
        Method::GET,
        &format!("/v4/assets/{sha}?scopeId={books}"),
        &token_a,
        Body::empty(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(served, bytes);

    // Same token, but the blob was never granted to the novels scope.
    let (status, _) = v4_raw(
        &app,
        Method::GET,
        &format!("/v4/assets/{sha}?scopeId={novels}"),
        &token_a,
        Body::empty(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A different profile's token is refused for a scope it does not hold.
    let (status, _) = v4_raw(
        &app,
        Method::GET,
        &format!("/v4/assets/{sha}?scopeId={novels}"),
        &token_b,
        Body::empty(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

async fn open_v4_env_at(data_dir: &std::path::Path) -> (SharedAppState, axum::Router) {
    let mut config = SyncdConfig::from_env();
    config.data_dir = data_dir.to_path_buf();
    config.db_path = data_dir.join("syncd.sqlite");

    let pool = db::connect(&config).await.unwrap();
    db::upsert_server_identity(&pool, &config, "v4-test-fingerprint")
        .await
        .unwrap();

    let advertised =
        crate::syncd::config::SyncdAdvertisedEndpointResolver::from_config(&config).unwrap();
    let descriptor = SyncdDiscoveryDescriptorProvider::from_config(&config).unwrap();
    let manager = SyncdDiscoveryProviderManager::from_config(&config).unwrap();
    let initial_status = manager.initial_status(&config, &advertised);

    let (change_sender, _) = broadcast::channel(128);
    let (pairing_status_sender, _) = broadcast::channel(32);

    let state = Arc::new(AppState {
        config: config.clone(),
        advertised_endpoint_resolver: advertised,
        discovery_descriptor_provider: descriptor,
        client_discovery_contract_provider: SyncdClientDiscoveryContractProvider::default(),
        client_discovery_guidance_provider: SyncdClientDiscoveryGuidanceProvider::default(),
        discovery_provider_manager: manager,
        discovery_provider_state: Arc::new(RwLock::new(initial_status)),
        discovery_provider_runtime: Arc::new(Mutex::new(None)),
        pool,
        change_sender,
        pairing_status_sender,
        mutation_gate: Arc::new(Mutex::new(())),
        tls_cert_sha256: "v4-test-fingerprint".to_string(),
        device_presence: Default::default(),
    });

    let router = build_router_for_tests(state.clone());
    (state, router)
}

#[tokio::test]
async fn v4_mid_sync_core_restart_preserves_cursor_idempotency_and_convergence() {
    let temp = TempDir::new().unwrap();
    let (state_1, app_1) = open_v4_env_at(temp.path()).await;

    let token_phone = db::issue_local_authority_token(
        &state_1.pool,
        &state_1.config,
        "android-phone-a",
        "profile-alpha",
    )
    .await
    .unwrap()
    .access_token;
    let token_desktop = db::issue_local_authority_token(
        &state_1.pool,
        &state_1.config,
        "desktop-pc-b",
        "profile-alpha",
    )
    .await
    .unwrap()
    .access_token;

    let now = db::now_ms();

    // 1. Pre-restart: Phone uploads Batch 1 via /v4/sync/bulk across comics, novels, and books.
    let (status, _, bulk_1) = v4_request(
        &app_1,
        Method::POST,
        "/v4/sync/bulk",
        &token_phone,
        Some(json!({
            "items": [
                {
                    "clientMutationId": "restart-mut-1",
                    "domain": "comics",
                    "entityType": "comic.work",
                    "entityKey": "src1:/manga/alpha",
                    "deleted": false,
                    "hlc": { "tsMs": now, "counter": 0, "deviceId": "android-phone-a" },
                    "payload": { "title": "Alpha Manga", "favorite": true }
                },
                {
                    "clientMutationId": "restart-mut-2",
                    "domain": "novels",
                    "entityType": "novel.work",
                    "entityKey": "p1:/novel/beta",
                    "deleted": false,
                    "hlc": { "tsMs": now, "counter": 1, "deviceId": "android-phone-a" },
                    "payload": { "title": "Beta Novel", "inLibrary": true }
                },
                {
                    "clientMutationId": "restart-mut-3",
                    "domain": "books",
                    "entityType": "book.item",
                    "entityKey": "book:gamma",
                    "deleted": false,
                    "hlc": { "tsMs": now, "counter": 2, "deviceId": "android-phone-a" },
                    "payload": { "title": "Gamma Book", "progressPercent": 15.0 }
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bulk_1["acceptedCount"], json!(3));

    // 2. Pre-restart: Phone uploads Batch 2 (in-flight batch) via /v4/deltas.
    let in_flight_deltas = json!({
        "items": [
            {
                "clientMutationId": "restart-mut-4",
                "domain": "comics",
                "entityType": "comic.chapter",
                "entityKey": "src1:/manga/alpha|/manga/alpha/ch-1",
                "deleted": false,
                "hlc": { "tsMs": now + 10, "counter": 0, "deviceId": "android-phone-a" },
                "payload": { "isRead": true, "lastPageRead": 18 }
            },
            {
                "clientMutationId": "restart-mut-5",
                "domain": "novels",
                "entityType": "novel.chapter",
                "entityKey": "p1:/novel/beta|/novel/beta/ch-1",
                "deleted": false,
                "hlc": { "tsMs": now + 10, "counter": 1, "deviceId": "android-phone-a" },
                "payload": { "isRead": true, "progressPercent": 100.0 }
            }
        ]
    });
    let (status, _, deltas_1) = v4_request(
        &app_1,
        Method::POST,
        "/v4/deltas",
        &token_phone,
        Some(in_flight_deltas.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deltas_1["acceptedCount"], json!(2));

    // Desktop pulls only the first 3 changes before Core restarts, persisting its cursor.
    let (status, _, pre_changes) = v4_request(
        &app_1,
        Method::GET,
        "/v4/changes?sinceSeq=0&limit=3",
        &token_desktop,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let pre_list = pre_changes["changes"].as_array().unwrap();
    assert_eq!(pre_list.len(), 3);
    assert_eq!(pre_changes["hasMore"], json!(true));
    let persisted_cursor = pre_changes["nextSeq"].as_i64().unwrap();
    assert!(persisted_cursor >= 3);

    // 3. Simulate Core restart: drop router + AppState/V4Runtime and close SQLite pool.
    drop(app_1);
    let pool_1 = state_1.pool.clone();
    drop(state_1);
    pool_1.close().await;

    // Reconstruct fresh SQLite pool, V4Runtime, and Axum router on the exact same syncd.sqlite.
    let (_state_2, app_2) = open_v4_env_at(temp.path()).await;

    // 4. Post-restart: Phone replays the in-flight /v4/deltas batch with the same clientMutationId.
    let (status, _, replay_resp) = v4_request(
        &app_2,
        Method::POST,
        "/v4/deltas",
        &token_phone,
        Some(in_flight_deltas),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay_resp["acceptedCount"], json!(0));
    assert_eq!(replay_resp["deduplicatedCount"], json!(2));

    // Phone also uploads a post-restart /v4/sync/bulk batch (new book + updated comic).
    let (status, _, bulk_2) = v4_request(
        &app_2,
        Method::POST,
        "/v4/sync/bulk",
        &token_phone,
        Some(json!({
            "items": [
                {
                    "clientMutationId": "restart-mut-6",
                    "domain": "books",
                    "entityType": "book.item",
                    "entityKey": "book:delta",
                    "deleted": false,
                    "hlc": { "tsMs": now + 20, "counter": 0, "deviceId": "android-phone-a" },
                    "payload": { "title": "Delta Book", "progressPercent": 42.0 }
                }
            ]
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bulk_2["acceptedCount"], json!(1));

    // 5. Desktop resumes /v4/changes from its persisted_cursor.
    let (status, _, post_changes) = v4_request(
        &app_2,
        Method::GET,
        &format!("/v4/changes?sinceSeq={persisted_cursor}&limit=20"),
        &token_desktop,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let post_list = post_changes["changes"].as_array().unwrap();
    // Exactly 3 remaining changes: mut-4, mut-5, mut-6 (no duplicates from replay).
    assert_eq!(post_list.len(), 3);
    assert_eq!(post_changes["hasMore"], json!(false));

    // Verify monotonic serverSeq across the restart boundary.
    let mut prev_seq = persisted_cursor;
    for ch in post_list {
        let seq = ch["serverSeq"].as_i64().unwrap();
        assert!(seq > prev_seq, "serverSeq must be strictly monotonic");
        assert_eq!(ch["deleted"], json!(false), "no phantom tombstones");
        prev_seq = seq;
    }

    // 6. Exact convergence across both devices via /v4/snapshot.
    let (status, _, snap_phone) =
        v4_request(&app_2, Method::GET, "/v4/snapshot", &token_phone, None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, snap_desktop) =
        v4_request(&app_2, Method::GET, "/v4/snapshot", &token_desktop, None).await;
    assert_eq!(status, StatusCode::OK);

    assert_eq!(snap_phone["recordCount"], json!(6));
    assert_eq!(snap_desktop["recordCount"], json!(6));
    assert_eq!(snap_phone["records"], snap_desktop["records"]);
}

async fn store_unprojected_phone_category(app: &axum::Router, token: &str) {
    let (status, _, _) = v4_request(
        app,
        Method::POST,
        "/v4/sync/bulk",
        token,
        Some(json!({"finalBatch":true,"items":[{
            "domain":"comics","entityType":"comic.category","entityKey":"from-phone",
            "hlc":{"tsMs":1,"deviceId":"phone"},"payload":{"name":"From phone","order":1}
        }]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

async fn stored_categories(state: &SharedAppState) -> Vec<(String, i64)> {
    sqlx::query_as(
        "SELECT entity_key, deleted FROM v4_records
         WHERE profile_id = 'profile-alpha' AND entity_type = 'comic.category'",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn desktop_catalog_capture_skips_while_a_phone_category_awaits_projection() {
    let (_temp, state, app, token, _) = build_v4_test_env().await;
    store_unprojected_phone_category(&app, &token).await;
    // A closed port: never reach a real Suwayomi from a test.
    state
        .config
        .set_suwayomi_proxy_test_upstream("profile-alpha", "http://127.0.0.1:9/");
    let runtime = V4Runtime::new();
    // No Suwayomi answers here: reading it would fail, so Ok proves the capture never diffed a
    // Suwayomi that lacks the phone's category, and the category must survive untouched.
    super::suwayomi::capture_local_edits_with_wait(
        &state,
        &runtime,
        "profile-alpha",
        Vec::new(),
        Vec::new(),
        true,
        std::time::Duration::from_millis(50),
    )
    .await
    .unwrap();
    assert_eq!(stored_categories(&state).await, vec![("from-phone".to_owned(), 0)]);
}

#[tokio::test]
async fn desktop_catalog_capture_reads_suwayomi_once_the_projection_settles() {
    let (_temp, state, app, token, _) = build_v4_test_env().await;
    store_unprojected_phone_category(&app, &token).await;
    // A closed port: never reach a real Suwayomi from a test.
    state
        .config
        .set_suwayomi_proxy_test_upstream("profile-alpha", "http://127.0.0.1:9/");
    sqlx::query(
        "UPDATE v4_comics_projection SET applied_seq = target_seq WHERE profile_id = 'profile-alpha'",
    )
    .execute(&state.pool)
    .await
    .unwrap();
    let runtime = V4Runtime::new();
    // Settled: the capture goes on to read Suwayomi, which is unreachable in this test.
    let result = super::suwayomi::capture_local_edits_with_wait(
        &state,
        &runtime,
        "profile-alpha",
        Vec::new(),
        Vec::new(),
        true,
        std::time::Duration::from_millis(50),
    )
    .await;
    assert!(result.is_err(), "a settled projection must let the catalog capture read Suwayomi");
    assert_eq!(stored_categories(&state).await, vec![("from-phone".to_owned(), 0)]);
}

/// A stand-in Suwayomi GraphQL endpoint answering the three baseline queries by operation name.
async fn fake_suwayomi_library() -> String {
    async fn graphql(axum::Json(body): axum::Json<Value>) -> axum::Json<Value> {
        let query = body["query"].as_str().unwrap_or_default();
        let data = if query.contains("EpigraphV4ComicLibrary") {
            json!({"mangas": {
                "nodes": [
                    {"id": 1, "sourceId": "100", "url": "https://s/alpha", "title": "Alpha"},
                    {"id": 2, "sourceId": "100", "url": "https://s/default-only", "title": "Default Only"},
                    {"id": 3, "sourceId": "200", "url": "https://s/completed-only", "title": "Completed Only"}
                ],
                "pageInfo": {"hasNextPage": false}
            }})
        } else if query.contains("EpigraphV4ComicCategoryMembership") {
            let alpha = json!({"id": 1, "sourceId": "100", "url": "https://s/alpha", "title": "Alpha", "inLibrary": true});
            let default_only = json!({"id": 2, "sourceId": "100", "url": "https://s/default-only", "title": "Default Only", "inLibrary": true});
            let completed_only = json!({"id": 3, "sourceId": "200", "url": "https://s/completed-only", "title": "Completed Only", "inLibrary": true});
            json!({"categories": {
                "nodes": [
                    {"id": 0, "name": "Default", "order": 0, "mangas": {"nodes": [alpha.clone(), default_only]}},
                    {"id": -2, "name": "Completed", "order": 1, "mangas": {"nodes": [completed_only]}},
                    {"id": 7, "name": "Reading", "order": 2, "mangas": {"nodes": [alpha]}}
                ],
                "pageInfo": {"hasNextPage": false}
            }})
        } else if query.contains("EpigraphV4ComicChapters") {
            json!({"chapters": {
                "nodes": [
                    {"id": 11, "mangaId": 1, "url": "https://s/alpha/1", "name": "One", "chapterNumber": 1, "scanlator": null, "isRead": true, "isBookmarked": false, "lastPageRead": 0},
                    {"id": 12, "mangaId": 1, "url": "https://s/alpha/2", "name": "Two", "chapterNumber": 2, "scanlator": null, "isRead": false, "isBookmarked": false, "lastPageRead": 7},
                    {"id": 13, "mangaId": 2, "url": "https://s/default-only/1", "name": "One", "chapterNumber": 1, "scanlator": null, "isRead": false, "isBookmarked": false, "lastPageRead": 0}
                ],
                "pageInfo": {"hasNextPage": false}
            }})
        } else {
            return axum::Json(json!({"errors": [{"message": "unexpected operation"}]}));
        };
        axum::Json(json!({"data": data}))
    }
    let app = axum::Router::new().route("/api/graphql", axum::routing::post(graphql));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{address}/")
}

async fn live_record_counts(state: &SharedAppState) -> Vec<(String, i64)> {
    sqlx::query_as(
        "SELECT entity_type, COUNT(*) FROM v4_records
         WHERE profile_id = 'profile-alpha' AND deleted = 0
         GROUP BY entity_type ORDER BY entity_type",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap()
}

async fn settle_projection(state: &SharedAppState) {
    sqlx::query(
        "UPDATE v4_comics_projection SET applied_seq = target_seq WHERE profile_id = 'profile-alpha'",
    )
    .execute(&state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn desktop_comic_baseline_publishes_the_library_and_then_commits_nothing() {
    let (_temp, state, app, token, _) = build_v4_test_env().await;
    store_unprojected_phone_category(&app, &token).await;
    state
        .config
        .set_suwayomi_proxy_test_upstream("profile-alpha", &fake_suwayomi_library().await);
    let runtime = V4Runtime::new();

    settle_projection(&state).await;
    assert!(super::suwayomi::capture_comic_library_baseline(&state, &runtime, "profile-alpha")
        .await
        .unwrap());
    let published = live_record_counts(&state).await;
    let count = |counts: &[(String, i64)], entity: &str| {
        counts
            .iter()
            .find(|(kind, _)| kind == entity)
            .map_or(0, |(_, n)| *n)
    };
    // Three library works (including Default-only and Completed-only), one real category next
    // to the phone's, one membership, and the two chapters that carry progress.
    assert_eq!(count(&published, "comic.work"), 3, "{published:?}");
    assert_eq!(count(&published, "comic.category"), 2, "{published:?}");
    assert_eq!(count(&published, "comic.category_assignment"), 1, "{published:?}");
    assert_eq!(count(&published, "comic.chapter"), 2, "{published:?}");
    let title: (String,) = sqlx::query_as(
        "SELECT payload_json FROM v4_records WHERE profile_id = 'profile-alpha'
         AND entity_type = 'comic.work' AND entity_key = ?",
    )
    .bind(canonical_work_key("100", "https://s/default-only"))
    .fetch_one(&state.pool)
    .await
    .unwrap();
    let payload: Value = serde_json::from_str(&title.0).unwrap();
    assert_eq!(payload["title"], "Default Only");
    let reserved: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM v4_records WHERE profile_id = 'profile-alpha'
         AND entity_type = 'comic.category' AND entity_key IN ('default', 'completed')",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(reserved, 0);

    // A second run, against a settled projection again, commits zero records.
    let seq_before: i64 = sqlx::query_scalar(
        "SELECT current_seq FROM v4_profile_watermarks WHERE profile_id = 'profile-alpha'",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    settle_projection(&state).await;
    assert!(super::suwayomi::capture_comic_library_baseline(&state, &runtime, "profile-alpha")
        .await
        .unwrap());
    let seq_after: i64 = sqlx::query_scalar(
        "SELECT current_seq FROM v4_profile_watermarks WHERE profile_id = 'profile-alpha'",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(seq_after, seq_before, "the second run must not append to the change log");
    assert_eq!(live_record_counts(&state).await, published);
}
