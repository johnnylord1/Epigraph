fn main() {
    for name in ["EPIGRAPH_BUILD_ID", "EPIGRAPH_SOURCE_FINGERPRINT"] {
        println!("cargo:rerun-if-env-changed={name}");
        if let Ok(value) = std::env::var(name) { println!("cargo:rustc-env={name}={value}"); }
    }
    let attributes = tauri_build::Attributes::new().plugin(
        "library-share",
        tauri_build::InlinedPlugin::new().commands(&[
            "upload_card",
            "fetch_share_payload",
            "take_pending_import_link",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to build the Tauri application");
}
