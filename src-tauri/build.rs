fn main() {
    for name in ["EPIGRAPH_BUILD_ID", "EPIGRAPH_SOURCE_FINGERPRINT"] {
        println!("cargo:rerun-if-env-changed={name}");
        if let Ok(value) = std::env::var(name) { println!("cargo:rustc-env={name}={value}"); }
    }
    tauri_build::build()
}
