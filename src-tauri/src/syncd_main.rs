#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[allow(dead_code)]
mod suwayomi_maintenance;
#[allow(dead_code)]
mod suwayomi_recovery;
#[allow(dead_code)]
mod suwayomi_runtime;
#[allow(dead_code)]
mod suwayomi_runtime_store;
mod syncd;

// `desktop_library` is exercised by `v4_desktop_sync` in `epigraph_lib`; keep its entrypoints
// reachable here without suppressing real `dead_code` warnings inside `desktop_library.rs`.
const _: () = {
    let _ = syncd::v4::desktop_library::export_desktop_novels_to_v4;
    let _ = syncd::v4::desktop_library::apply_v4_records_to_desktop_novels;
    let _ = syncd::v4::desktop_library::export_desktop_books_to_v4;
    let _ = syncd::v4::desktop_library::apply_v4_records_to_desktop_books;
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    epigraph_lib::promote_legacy_environment();
    epigraph_lib::migrate_legacy_core_storage();
    syncd::run_command_line().await
}
