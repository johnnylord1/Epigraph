//! Compatibility bridges used during the Epigraph rebrand.
//!
//! The product-facing names are canonicalized at process start, but legacy
//! environment variables and data roots remain readable.  Nothing in this
//! module removes or overwrites legacy data.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

/// Promote legacy AETHON environment variables to their EPIGRAPH names.
///
/// The canonical variable always wins when both names are present.  This is
/// deliberately process-local: it does not mutate the user's shell profile.
pub fn promote_legacy_environment() {
    let variables = std::env::vars_os().collect::<Vec<_>>();
    for (key, value) in variables {
        let Some(canonical_key) = canonical_environment_key(&key) else {
            continue;
        };
        if std::env::var_os(&canonical_key).is_none() {
            std::env::set_var(canonical_key, value);
        }
    }
}

fn canonical_environment_key(key: &OsStr) -> Option<OsString> {
    let key = key.to_str()?;
    if let Some(suffix) = key.strip_prefix("VITE_AETHON_") {
        return Some(OsString::from(format!("VITE_EPIGRAPH_{suffix}")));
    }
    key.strip_prefix("AETHON_")
        .map(|suffix| OsString::from(format!("EPIGRAPH_{suffix}")))
}

/// Migrate the known desktop storage roots without deleting the source.
///
/// Files are copied atomically one by one, and conflicts are left untouched so
/// a newer Epigraph file can never be silently overwritten by an older Aethon
/// file.  Re-running the function is safe: existing destinations are skipped
/// and missing files are filled in on the next run.
pub fn migrate_legacy_storage() {
    for (legacy, canonical) in migration_pairs() {
        if let Err(error) = merge_directory(&legacy, &canonical) {
            eprintln!("[Epigraph] legacy migration {} -> {} failed: {error}", legacy.display(), canonical.display());
        }
    }
}

fn migration_pairs() -> Vec<(PathBuf, PathBuf)> {
    let mut pairs = Vec::new();
    let roaming = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(dirs::data_dir);
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(dirs::data_local_dir);

    if let Some(base) = roaming.as_ref() {
        push_pair(&mut pairs, base.join("Aethon"), base.join("epigraph"));
        push_pair(&mut pairs, base.join("aethon"), base.join("epigraph"));
        push_pair(&mut pairs, base.join("dev.aethon.app"), base.join("dev.epigraph.app"));
        push_pair(&mut pairs, base.join("aethon-main"), base.join("epigraph-main"));
        push_pair(&mut pairs, base.join("Aethon-main"), base.join("epigraph-main"));
        append_profile_pairs(&mut pairs, base);
    }

    if let Some(base) = local.as_ref() {
        push_pair(&mut pairs, base.join("Aethon"), base.join("Epigraph"));
        push_pair(&mut pairs, base.join("aethon"), base.join("Epigraph"));
        push_pair(&mut pairs, base.join("dev.aethon.app"), base.join("dev.epigraph.app"));
        push_pair(&mut pairs, base.join("aethon-main"), base.join("epigraph-main"));
        push_pair(&mut pairs, base.join("Aethon-main"), base.join("epigraph-main"));
        append_profile_pairs(&mut pairs, base);
    }

    pairs
}

fn append_profile_pairs(pairs: &mut Vec<(PathBuf, PathBuf)>, base: &Path) {
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if let Some(suffix) = lower.strip_prefix("aethon-profile-") {
            push_pair(
                pairs,
                entry.path(),
                base.join(format!("epigraph-profile-{suffix}")),
            );
        }
    }
}

fn push_pair(pairs: &mut Vec<(PathBuf, PathBuf)>, legacy: PathBuf, canonical: PathBuf) {
    if legacy == canonical || legacy.to_string_lossy().eq_ignore_ascii_case(&canonical.to_string_lossy()) {
        return;
    }
    if pairs.iter().any(|(existing, target)| {
        existing.to_string_lossy().eq_ignore_ascii_case(&legacy.to_string_lossy())
            && target.to_string_lossy().eq_ignore_ascii_case(&canonical.to_string_lossy())
    }) {
        return;
    }
    pairs.push((legacy, canonical));
}

fn merge_directory(source: &Path, destination: &Path) -> std::io::Result<()> {
    if !source.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(destination)?;

    for entry in WalkDir::new(source).min_depth(1).follow_links(false) {
        let entry = entry.map_err(std::io::Error::other)?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(std::io::Error::other)?;
        let target = destination.join(relative);

        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        copy_file_atomically(entry.path(), &target)?;
    }
    Ok(())
}

fn copy_file_atomically(source: &Path, destination: &Path) -> std::io::Result<()> {
    if destination.exists() {
        return Ok(());
    }
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let temporary = destination.with_file_name(format!(
        ".{file_name}.epigraph-migrating-{}",
        std::process::id()
    ));
    let _ = fs::remove_file(&temporary);
    fs::copy(source, &temporary)?;
    match fs::rename(&temporary, destination) {
        Ok(()) => Ok(()),
        Err(_error) if destination.exists() => {
            let _ = fs::remove_file(&temporary);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn canonical_environment_name_preserves_suffix() {
        assert_eq!(
            canonical_environment_key(OsStr::new("AETHON_SYNCD_PORT")),
            Some(OsString::from("EPIGRAPH_SYNCD_PORT"))
        );
        assert_eq!(
            canonical_environment_key(OsStr::new("VITE_AETHON_GITHUB_REPO")),
            Some(OsString::from("VITE_EPIGRAPH_GITHUB_REPO"))
        );
        assert_eq!(canonical_environment_key(OsStr::new("OTHER_VALUE")), None);
    }

    #[test]
    fn merge_is_idempotent_and_never_overwrites_canonical_files() {
        let root = tempdir().unwrap();
        let source = root.path().join("Aethon");
        let destination = root.path().join("Epigraph");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("nested/legacy.txt"), "legacy").unwrap();
        fs::create_dir_all(destination.join("nested")).unwrap();
        fs::write(destination.join("nested/legacy.txt"), "new").unwrap();

        merge_directory(&source, &destination).unwrap();
        merge_directory(&source, &destination).unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("nested/legacy.txt")).unwrap(),
            "new"
        );
        assert!(source.join("nested/legacy.txt").exists());
    }
}
