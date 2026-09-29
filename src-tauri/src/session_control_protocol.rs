//! Exact-run control validation. No process lookup or destructive fallback.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub version: u32,
    pub run_id: String,
    pub nonce: String,
    pub project: String,
    pub profile: String,
    pub build: String,
    pub record_hash: String,
    pub capability: String,
    pub action: String,
    #[serde(default)]
    pub challenge: Option<String>,
    #[serde(default)]
    pub proof: Option<String>,
}

pub struct Gate {
    pub expected: Request,
    seen: HashSet<String>,
}
impl Gate {
    pub fn new(expected: Request) -> Self { Self { expected, seen: HashSet::new() } }
    pub fn accept(&mut self, request: &Request, record_unchanged: bool) -> Result<(), String> {
        let expected = &self.expected;
        if !record_unchanged || request.version != 1 || !canonical_uuid(&request.run_id)
            || !canonical_uuid(&request.nonce) || request.run_id != expected.run_id
            || request.project.is_empty() || request.project != expected.project
            || request.profile.is_empty() || request.profile != expected.profile
            || !sha256(&request.build) || request.build != expected.build
            || !sha256(&request.record_hash) || request.record_hash != expected.record_hash
            || !sha256(&request.capability) || request.capability != expected.capability
            || !matches!(request.action.as_str(), "shutdown" | "focus" | "focus-main" | "attest" | "challenge" | "verify-page")
            || self.seen.len() >= 4096 || !self.seen.insert(request.nonce.clone()) {
            return Err("Missing, stale, replayed or foreign control evidence".into());
        }
        Ok(())
    }
}

pub fn sha256(value: &str) -> bool { value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()) }
pub fn canonical_uuid(value: &str) -> bool {
    value.len() == 36 && value.bytes().any(|c| matches!(c, b'1'..=b'9' | b'a'..=b'f'))
        && value.bytes().enumerate().all(|(i,c)| if [8,13,18,23].contains(&i) { c == b'-' } else { matches!(c,b'0'..=b'9' | b'a'..=b'f') })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        Request { version: 1, run_id: "23e9acda-12e8-4d50-97cf-21cf1773e3c1".into(),
            nonce: "6cc221bc-03a4-4a49-8482-704154d34868".into(), project: "C:\\fixture".into(),
            profile: "fixture-profile".into(), build: "a".repeat(64), record_hash: "b".repeat(64),
            capability: "c".repeat(64), action: "shutdown".into(), challenge: None, proof: None }
    }
    #[test]
    fn exact_request_accepted_once_and_replay_rejected() {
        let request = request(); let mut gate = Gate::new(request.clone());
        assert!(gate.accept(&request, true).is_ok());
        assert!(gate.accept(&request, true).is_err());
    }
    #[test]
    fn foreign_missing_stale_and_ambiguous_requests_never_authorize_action() {
        for field in ["version", "runId", "nonce", "project", "profile", "build", "recordHash", "capability", "action"] {
            let expected = request(); let mut value = serde_json::to_value(&expected).unwrap();
            value[field] = if field == "version" { serde_json::json!(2) } else { serde_json::json!("") };
            let invalid: Request = serde_json::from_value(value).unwrap();
            assert!(Gate::new(expected).accept(&invalid, true).is_err(), "{field}");
        }
        let request = request();
        assert!(Gate::new(request.clone()).accept(&request, false).is_err());
        for field in ["runId", "profile", "capability", "recordHash"] {
            let mut value = serde_json::to_value(&request).unwrap(); value.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<Request>(value).is_err());
        }
        assert!(serde_json::from_str::<Request>("{broken").is_err());
        let mut value = serde_json::to_value(&request).unwrap(); value["foreignField"] = serde_json::json!(true);
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
}
