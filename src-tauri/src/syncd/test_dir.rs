//! Temporary directories for Syncd tests.
//!
//! On Windows a test's directory often outlives it: the SQLite pool closes its connections on
//! worker threads after the test returns, so `TempDir` cannot remove a file that is still open
//! and silently gives up. Test directories therefore live under one root of their own, and the
//! first test of each run removes the ones a previous run left there.

use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::{Duration, SystemTime};

use tempfile::TempDir;

/// Older than any test run, so a directory past it belongs to no running test.
const LEFTOVER_AGE: Duration = Duration::from_secs(60 * 60);

static SWEEP: Once = Once::new();

/// A fresh test directory, removed on drop when Windows allows it and by a later run otherwise.
pub(crate) fn tempdir() -> std::io::Result<TempDir> {
    let root = root();
    std::fs::create_dir_all(&root)?;
    SWEEP.call_once(|| remove_leftovers(&root, SystemTime::now()));
    tempfile::Builder::new().prefix("t").tempdir_in(&root)
}

fn root() -> PathBuf {
    std::env::temp_dir().join("epigraph-syncd-tests")
}

fn remove_leftovers(root: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > LEFTOVER_AGE);
        if old && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_directories_share_one_root_and_old_ones_are_removed() {
        let dir = tempdir().unwrap();
        assert_eq!(dir.path().parent(), Some(root().as_path()));

        let sweep_root = tempfile::tempdir().unwrap();
        let leftover = sweep_root.path().join("left");
        std::fs::create_dir(&leftover).unwrap();
        std::fs::write(leftover.join("syncd.sqlite"), b"").unwrap();
        let loose_file = sweep_root.path().join("file");
        std::fs::write(&loose_file, b"").unwrap();

        // A directory from the current run stays.
        remove_leftovers(sweep_root.path(), SystemTime::now());
        assert!(leftover.exists());
        // One older than any run goes; files beside it are not ours to judge.
        remove_leftovers(sweep_root.path(), SystemTime::now() + LEFTOVER_AGE * 2);
        assert!(!leftover.exists());
        assert!(loose_file.exists());
    }
}
