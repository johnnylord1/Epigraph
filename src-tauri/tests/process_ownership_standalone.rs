#[path = "../src/process_ownership.rs"]
mod process_ownership;
use process_ownership::*;

struct Candidate {
    actual: Result<Identity, String>,
    kills: usize,
    fail_kill: bool,
    timeout: bool,
}
impl ProcessObject for Candidate {
    fn identity(&self) -> Result<Identity, String> {
        self.actual.clone()
    }
    fn terminate(&mut self) -> Result<(), String> {
        self.kills += 1;
        if self.fail_kill {
            Err("denied".into())
        } else {
            Ok(())
        }
    }
    fn wait(&self, _: u32) -> Result<(), String> {
        if self.timeout {
            Err("timeout".into())
        } else {
            Ok(())
        }
    }
}
fn identity() -> Identity {
    Identity {
        pid: 42,
        created: 133700000001234567,
        executable: "C:\\app\\java.exe".into(),
        command_hash: "a".repeat(64),
    }
}
fn owner() -> Ownership<'static> {
    Ownership {
        run_id: Some("12ab34cd-1234-4567-89ab-0123456789ab"),
        requested_run_id: "12ab34cd-1234-4567-89ab-0123456789ab",
        profile: "test",
        root: "C:\\profiles\\test",
        requested_profile: "test",
        requested_root: "C:\\profiles\\test",
        spawned: true,
        attach_only: false,
        identity: Some(identity()),
    }
}
fn candidate() -> Candidate {
    Candidate {
        actual: Ok(identity()),
        kills: 0,
        fail_kill: false,
        timeout: false,
    }
}

#[test]
fn correct_identity_terminates_the_validated_object_and_confirms_exit() {
    let mut process = candidate();
    assert!(stop_verified(&owner(), &mut process, || true).is_ok());
    assert_eq!(process.kills, 1);
}
#[test]
fn rejection_matrix_never_terminates() {
    for case in [
        "wrong creation",
        "reused PID",
        "foreign run",
        "nil run",
        "missing identity",
        "missing run",
        "malformed run",
        "stale record",
        "foreign profile",
        "foreign root",
        "disappeared",
        "query denied",
        "ambiguous",
        "discovered Core",
        "attach only",
        "empty path",
        "empty hash",
        "zero creation",
        "wrong executable",
        "wrong command",
    ] {
        let mut record = owner();
        let mut process = candidate();
        let mut unchanged = true;
        match case {
            "wrong creation" | "reused PID" => process.actual.as_mut().unwrap().created += 1,
            "missing identity" => record.identity = None,
            "missing run" => record.run_id = None,
            "foreign run" => record.run_id = Some("22ab34cd-1234-4567-89ab-0123456789ab"),
            "nil run" => record.run_id = Some("00000000-0000-0000-0000-000000000000"),
            "malformed run" => record.run_id = Some("broken"),
            "stale record" | "ambiguous" => unchanged = false,
            "foreign profile" => record.profile = "other",
            "foreign root" => record.root = "C:\\other",
            "disappeared" | "query denied" => process.actual = Err(case.into()),
            "discovered Core" => record.spawned = false,
            "attach only" => record.attach_only = true,
            "empty path" => record.identity.as_mut().unwrap().executable.clear(),
            "empty hash" => record.identity.as_mut().unwrap().command_hash.clear(),
            "zero creation" => record.identity.as_mut().unwrap().created = 0,
            "wrong executable" => {
                process.actual.as_mut().unwrap().executable = "C:\\foreign.exe".into()
            }
            "wrong command" => process.actual.as_mut().unwrap().command_hash = "b".repeat(64),
            _ => unreachable!(),
        }
        assert!(
            stop_verified(&record, &mut process, || unchanged).is_err(),
            "{case}"
        );
        assert_eq!(process.kills, 0, "{case}");
    }
}
#[test]
fn termination_failure_and_timeout_do_not_confirm_cleanup() {
    for timeout in [false, true] {
        let mut process = candidate();
        process.timeout = timeout;
        process.fail_kill = !timeout;
        assert!(stop_verified(&owner(), &mut process, || true).is_err());
        assert_eq!(process.kills, 1);
    }
}

#[cfg(windows)]
#[test]
fn windows_handle_rejects_wrong_birth_then_stops_only_its_owned_child() {
    use std::os::windows::process::CommandExt;
    let mut child = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"])
        .creation_flags(0x08000000)
        .spawn()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        fn test_hash(args: &[String]) -> String {
            assert!(args.iter().any(|arg| arg.contains("Start-Sleep")));
            "a".repeat(64)
        }
        let mut object = windows::Process::open(child.id(), test_hash).unwrap();
        let captured = object.identity().unwrap();
        let mut record = owner();
        record.identity = Some(captured.clone());
        record.identity.as_mut().unwrap().created += 1;
        assert!(stop_verified(&record, &mut object, || true).is_err());
        assert!(
            child.try_wait().unwrap().is_none(),
            "wrong birth must preserve child"
        );
        record.identity = Some(captured);
        assert!(stop_verified(&record, &mut object, || true).is_ok());
        assert!(
            child.try_wait().unwrap().is_some(),
            "exit confirmed before success"
        );
        assert!(
            stop_verified(&record, &mut object, || true).is_err(),
            "exited object is never reacquired by PID"
        );
        assert!(windows::Process::open(0, test_hash).is_err());
    }));
    let _ = child.kill();
    let _ = child.wait();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[cfg(windows)]
#[test]
fn windows_exit_proof_distinguishes_live_reused_unverifiable_and_exited_records() {
    use std::os::windows::process::CommandExt;
    let mut child = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"])
        .creation_flags(0x08000000)
        .spawn()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let pid = child.id();
        let created = windows::Process::open(pid, |_| String::new())
            .unwrap()
            .creation_time()
            .unwrap();
        assert_eq!(
            windows::recorded_process_exited(pid, Some(created)),
            Some(false)
        );
        assert_eq!(
            windows::recorded_process_exited(pid, Some(created + 1)),
            Some(true),
            "a reused PID with a different birth is not the recorded process"
        );
        assert_eq!(
            windows::recorded_process_exited(pid, None),
            None,
            "a live PID without a recorded birth is unverifiable"
        );
        assert_eq!(windows::recorded_process_exited(0, None), None);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(
            windows::recorded_process_exited(pid, Some(created)),
            Some(true)
        );
        assert_eq!(windows::recorded_process_exited(pid, None), Some(true));
    }));
    let _ = child.kill();
    let _ = child.wait();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
