use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::http::header::{ACCEPT_ENCODING, CONTENT_ENCODING, ETAG, IF_NONE_MATCH};
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

use crate::syncd::app::build_router_for_tests;
use crate::syncd::config::SyncdConfig;
use crate::syncd::db;
use crate::syncd::discovery::{
    SyncdClientDiscoveryContractProvider, SyncdClientDiscoveryGuidanceProvider,
    SyncdDiscoveryDescriptorProvider, SyncdDiscoveryProviderManager,
};
use crate::syncd::middleware::{CLIENT_PROTOCOL_HEADER, CLIENT_VERSION_HEADER};
use crate::syncd::models::{AppState, SharedAppState};
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
        own_echoes: Default::default(),
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
