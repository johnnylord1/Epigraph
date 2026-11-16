//! Merges a device just had applied, so its live stream can leave out their echo
//! (`supportsSkipOwnEchoesV1`).
//!
//! A first sync uploads thousands of records, and each one used to come straight back down the
//! device's own event stream with the record it had just been acknowledged with. A device that
//! confirms its writes from the acknowledgement opts out of that echo with `skipOwnEchoes=true`.
//!
//! Versions are remembered only after their write commits and before it is broadcast, so a stream
//! never misses one it should skip, and never skips a version a rolled-back write gave up. Only the
//! live stream skips: `/v1/changes` and replays after a reconnect still return every change, so a
//! device that failed to confirm a write still receives it there. Memory is bounded per device; a
//! version forgotten early is only echoed as before.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

/// More than a stream ever lags behind the writes of its own device.
const MAX_REMEMBERED_PER_DEVICE: usize = 20_000;

/// Remembered merges per device, owned by the running server.
#[derive(Clone, Default)]
pub struct OwnEchoes {
    remembered: Arc<Mutex<HashMap<String, BTreeSet<i64>>>>,
}

impl OwnEchoes {
    /// Records committed merges of `device_id`. Call before their envelopes are broadcast.
    pub fn remember(&self, device_id: &str, server_versions: impl IntoIterator<Item = i64>) {
        let mut remembered = self
            .remembered
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let versions = remembered.entry(device_id.to_string()).or_default();
        versions.extend(server_versions);
        while versions.len() > MAX_REMEMBERED_PER_DEVICE {
            versions.pop_first();
        }
        if versions.is_empty() {
            remembered.remove(device_id);
        }
    }

    /// Whether `server_version` is a merge `device_id` had applied, forgetting it and every older
    /// one: a stream receives versions in order, so it can no longer meet those.
    pub fn take(&self, device_id: &str, server_version: i64) -> bool {
        let mut remembered = self
            .remembered
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(versions) = remembered.get_mut(device_id) else {
            return false;
        };
        let found = versions.contains(&server_version);
        *versions = versions.split_off(&(server_version + 1));
        if versions.is_empty() {
            remembered.remove(device_id);
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_only_remembered_versions_and_forgets_older_ones() {
        let echoes = OwnEchoes::default();
        let device = "device";
        echoes.remember(device, [3, 5, 9]);
        assert!(!echoes.take(device, 4));
        assert!(echoes.take(device, 5));
        // 3 was older than the last version taken, so the stream has passed it.
        assert!(!echoes.take(device, 3));
        assert!(!echoes.take("other-device", 9));
        assert!(echoes.take(device, 9));
        assert!(!echoes.take(device, 9));
    }

    #[test]
    fn memory_per_device_is_bounded() {
        let echoes = OwnEchoes::default();
        let device = "device";
        echoes.remember(device, 0..(MAX_REMEMBERED_PER_DEVICE as i64 + 10));
        assert!(!echoes.take(device, 5));
        assert!(echoes.take(device, MAX_REMEMBERED_PER_DEVICE as i64 + 9));
    }
}
