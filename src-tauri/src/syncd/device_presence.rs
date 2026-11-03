//! Which paired devices are connected to this Core right now, kept in memory only.
//!
//! A device counts while it holds an open event stream or made a request within
//! `RECENT_REQUEST_WINDOW`. Local-authority tokens, held by the desktop on this computer and by
//! Core maintenance, never count: the desktop asking whether it may stop the Core must not keep
//! the Core alive itself.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A device that synced this recently still counts as connected without an open stream, such as
/// a phone finishing a background sync.
pub const RECENT_REQUEST_WINDOW: Duration = Duration::from_secs(120);

#[derive(Default)]
struct Presence {
    open_streams: usize,
    last_request: Option<Instant>,
}

#[derive(Default)]
struct Inner {
    devices: HashMap<String, Presence>,
    /// Event streams opened with a local-authority token. A desktop that opens the app again
    /// opens one, which tells a Core left running for devices that a desktop is back.
    local_stream_opens: u64,
}

#[derive(Clone, Default)]
pub struct DevicePresence {
    inner: Arc<Mutex<Inner>>,
    exit_when_devices_leave: Arc<AtomicBool>,
}

pub fn is_local_authority(token_id: &str) -> bool {
    token_id.starts_with("local-authority-")
}

impl DevicePresence {
    pub fn record_request(&self, token_id: &str, device_id: &str) {
        self.record_request_at(token_id, device_id, Instant::now());
    }

    fn record_request_at(&self, token_id: &str, device_id: &str, now: Instant) {
        if is_local_authority(token_id) {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        inner.devices.entry(device_id.to_string()).or_default().last_request = Some(now);
    }

    /// Count an event stream until the returned lease drops with the stream.
    pub fn open_stream(&self, token_id: &str, device_id: &str) -> StreamLease {
        let mut inner = self.inner.lock().unwrap();
        if is_local_authority(token_id) {
            inner.local_stream_opens += 1;
            return StreamLease {
                presence: self.clone(),
                device_id: None,
            };
        }
        inner.devices.entry(device_id.to_string()).or_default().open_streams += 1;
        StreamLease {
            presence: self.clone(),
            device_id: Some(device_id.to_string()),
        }
    }

    pub fn connected_devices(&self) -> usize {
        self.connected_devices_at(Instant::now())
    }

    fn connected_devices_at(&self, now: Instant) -> usize {
        let mut inner = self.inner.lock().unwrap();
        inner.devices.retain(|_, presence| {
            presence.open_streams > 0
                || presence.last_request.is_some_and(|at| {
                    now.saturating_duration_since(at) < RECENT_REQUEST_WINDOW
                })
        });
        inner.devices.len()
    }

    pub fn local_stream_opens(&self) -> u64 {
        self.inner.lock().unwrap().local_stream_opens
    }

    /// Claim the single watch that stops the Core once devices leave. False when one already runs.
    pub fn arm_exit_when_devices_leave(&self) -> bool {
        !self.exit_when_devices_leave.swap(true, Ordering::SeqCst)
    }

    pub fn disarm_exit_when_devices_leave(&self) {
        self.exit_when_devices_leave.store(false, Ordering::SeqCst);
    }

    /// Drop devices that only count through recent activity, as if the window had passed.
    #[cfg(test)]
    pub fn forget_recent_activity_for_test(&self) {
        self.inner.lock().unwrap().devices.retain(|_, presence| presence.open_streams > 0);
    }
}

pub struct StreamLease {
    presence: DevicePresence,
    device_id: Option<String>,
}

impl Drop for StreamLease {
    fn drop(&mut self) {
        let Some(device_id) = self.device_id.take() else {
            return;
        };
        let mut inner = self.presence.inner.lock().unwrap();
        if let Some(presence) = inner.devices.get_mut(&device_id) {
            presence.open_streams = presence.open_streams.saturating_sub(1);
            // The stream itself was activity: the device stays connected for the recent window,
            // which also covers a phone reconnecting after a network change.
            presence.last_request = Some(Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_counts_while_its_stream_is_open_and_shortly_after() {
        let presence = DevicePresence::default();
        assert_eq!(presence.connected_devices(), 0);

        let first = presence.open_stream("token-phone", "phone");
        let second = presence.open_stream("token-phone", "phone");
        let tablet = presence.open_stream("token-tablet", "tablet");
        assert_eq!(presence.connected_devices(), 2);

        drop(first);
        drop(tablet);
        assert_eq!(presence.connected_devices(), 2, "recently closed streams still count");
        let later = Instant::now() + RECENT_REQUEST_WINDOW + Duration::from_secs(1);
        assert_eq!(presence.connected_devices_at(later), 1, "the phone still has a stream");

        drop(second);
        let later = Instant::now() + RECENT_REQUEST_WINDOW + Duration::from_secs(1);
        assert_eq!(presence.connected_devices_at(later), 0);
    }

    #[test]
    fn a_recent_request_counts_until_the_window_passes() {
        let presence = DevicePresence::default();
        let now = Instant::now();
        presence.record_request_at("token-phone", "phone", now);
        assert_eq!(presence.connected_devices_at(now), 1);
        assert_eq!(
            presence.connected_devices_at(now + RECENT_REQUEST_WINDOW - Duration::from_secs(1)),
            1
        );
        assert_eq!(presence.connected_devices_at(now + RECENT_REQUEST_WINDOW), 0);
    }

    #[test]
    fn the_desktop_on_this_computer_never_counts_as_a_connected_device() {
        let presence = DevicePresence::default();
        presence.record_request("local-authority-desktop-main", "desktop");
        let stream = presence.open_stream("local-authority-desktop-main", "desktop");
        assert_eq!(presence.connected_devices(), 0);
        assert_eq!(presence.local_stream_opens(), 1);
        drop(stream);
        assert_eq!(presence.connected_devices(), 0);
    }

    #[test]
    fn only_one_exit_watch_runs_at_a_time() {
        let presence = DevicePresence::default();
        assert!(presence.arm_exit_when_devices_leave());
        assert!(!presence.arm_exit_when_devices_leave());
        presence.disarm_exit_when_devices_leave();
        assert!(presence.arm_exit_when_devices_leave());
    }
}
