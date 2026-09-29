//! Six-digit pairing PIN for desktop-to-desktop pairing on the local network.
//!
//! The host shows the PIN while "Add device" is open; another desktop that discovered the host
//! types it to receive the same bootstrap payload the QR code carries. The PIN is derived from the
//! session's secret pairing code, so it needs no storage and dies with the session. Failed guesses
//! are rate limited, and a burst of failures expires the open sessions so the host shows a new PIN.

use std::collections::VecDeque;
use std::sync::Mutex;

use sha2::{Digest, Sha256};

pub const PIN_LENGTH: usize = 6;
/// Failed resolutions allowed inside [`FAILURE_WINDOW_MS`] before PIN pairing locks.
pub const MAX_FAILURES: usize = 8;
pub const FAILURE_WINDOW_MS: i64 = 60_000;

/// Six decimal digits derived from the session's secret pairing code.
pub fn pairing_pin(pairing_code: &str) -> String {
    let digest = Sha256::digest(pairing_code.trim().as_bytes());
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{value:06}")
}

/// Accepts only a complete PIN; separators people type or paste (spaces, dashes) are ignored.
pub fn normalize_pin(raw: &str) -> Option<String> {
    let digits: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    (digits.len() == PIN_LENGTH && digits.chars().all(|c| c.is_ascii_digit())).then_some(digits)
}

#[derive(Debug, Default)]
pub struct PinAttemptLimiter {
    failures: VecDeque<i64>,
}

impl PinAttemptLimiter {
    fn prune(&mut self, now_ms: i64) {
        while self
            .failures
            .front()
            .is_some_and(|at| now_ms - *at >= FAILURE_WINDOW_MS)
        {
            self.failures.pop_front();
        }
    }

    pub fn is_locked(&mut self, now_ms: i64) -> bool {
        self.prune(now_ms);
        self.failures.len() >= MAX_FAILURES
    }

    /// Records a failed guess and reports whether this failure reached the lock threshold.
    pub fn record_failure(&mut self, now_ms: i64) -> bool {
        self.prune(now_ms);
        self.failures.push_back(now_ms);
        self.failures.len() == MAX_FAILURES
    }
}

/// Process-wide limiter: guesses are rate limited per host, not per client, since any LAN peer can try.
pub static PIN_ATTEMPTS: Mutex<PinAttemptLimiter> = Mutex::new(PinAttemptLimiter {
    failures: VecDeque::new(),
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_is_six_stable_digits_derived_from_the_secret_code() {
        let pin = pairing_pin("0192A7C4E5F1");
        assert_eq!(pin.len(), PIN_LENGTH);
        assert!(pin.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(pin, pairing_pin(" 0192A7C4E5F1 "));
        assert_ne!(pin, pairing_pin("0192A7C4E5F2"));
    }

    #[test]
    fn normalize_accepts_only_complete_numeric_pins() {
        assert_eq!(normalize_pin("123 456").as_deref(), Some("123456"));
        assert_eq!(normalize_pin("123-456").as_deref(), Some("123456"));
        assert_eq!(normalize_pin("12345"), None);
        assert_eq!(normalize_pin("12345a"), None);
        assert_eq!(normalize_pin("1234567"), None);
    }

    #[test]
    fn limiter_locks_after_a_burst_and_recovers_after_the_window() {
        let mut limiter = PinAttemptLimiter::default();
        for n in 0..MAX_FAILURES - 1 {
            assert!(!limiter.record_failure(n as i64));
            assert!(!limiter.is_locked(n as i64));
        }
        assert!(limiter.record_failure(10));
        assert!(limiter.is_locked(10));
        assert!(!limiter.is_locked(10 + FAILURE_WINDOW_MS));
    }
}
