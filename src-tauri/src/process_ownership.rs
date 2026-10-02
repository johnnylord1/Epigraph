//! B1: fail-closed process decisions, independent of Tauri and OS enumeration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub pid: u32,
    pub created: u64,
    pub executable: String,
    pub command_hash: String,
}

pub struct Ownership<'a> {
    pub run_id: Option<&'a str>,
    pub requested_run_id: &'a str,
    pub profile: &'a str,
    pub root: &'a str,
    pub requested_profile: &'a str,
    pub requested_root: &'a str,
    pub spawned: bool,
    pub attach_only: bool,
    pub identity: Option<Identity>,
}

pub trait ProcessObject {
    fn identity(&self) -> Result<Identity, String>;
    fn terminate(&mut self) -> Result<(), String>;
    fn wait(&self, timeout_ms: u32) -> Result<(), String>;
}

pub fn validate_record<'a>(owner: &'a Ownership<'_>) -> Result<&'a Identity, String> {
    let run = owner.run_id.unwrap_or("");
    let valid_run = run.len() == 36
        && run.bytes().any(|c| c.is_ascii_hexdigit() && c != b'0')
        && run.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        });
    if !valid_run
        || run != owner.requested_run_id
        || !owner.spawned
        || owner.attach_only
        || owner.profile.is_empty()
        || owner.root.is_empty()
        || owner.profile != owner.requested_profile
        || owner.root != owner.requested_root
    {
        return Err("Missing, foreign or attach-only ownership".into());
    }
    let expected = owner.identity.as_ref().ok_or("Missing process identity")?;
    if expected.pid == 0
        || expected.created == 0
        || expected.executable.is_empty()
        || expected.command_hash.len() != 64
        || !expected.command_hash.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("Incomplete process identity".into());
    }
    Ok(expected)
}

pub fn stop_verified(
    owner: &Ownership<'_>,
    process: &mut impl ProcessObject,
    record_unchanged: impl FnOnce() -> bool,
) -> Result<(), String> {
    let expected = validate_record(owner)?;
    if process.identity()? != *expected || !record_unchanged() {
        return Err("Stale or inconsistent ownership".into());
    }
    process.terminate()?;
    process.wait(5000)
}

/// A Windows handle is retained from inspection through termination AND wait.
/// Raw FFI keeps this boundary independently testable with rustc, without Tauri.
#[cfg(windows)]
pub mod windows {
    use super::{Identity, ProcessObject};
    use std::{ffi::c_void, os::windows::ffi::OsStringExt};
    type Handle = *mut c_void;
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum: u16,
        buffer: *const u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetProcessTimes(
            handle: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn QueryFullProcessImageNameW(
            handle: Handle,
            flags: u32,
            buffer: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn TerminateProcess(handle: Handle, code: u32) -> i32;
        fn WaitForSingleObject(handle: Handle, timeout: u32) -> u32;
        fn LocalFree(memory: Handle) -> Handle;
        fn GetLastError() -> u32;
        fn GetTickCount64() -> u64;
    }
    const ERROR_INVALID_PARAMETER: u32 = 87;
    const WAIT_OBJECT_0: u32 = 0;

    /// Wall-clock time (Unix seconds) of the current boot, from the uptime counter.
    pub fn boot_time_unix_secs() -> Option<u64> {
        let uptime = unsafe { GetTickCount64() } / 1000;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs();
        now.checked_sub(uptime)
    }

    /// Proves whether the process recorded with `pid` (and, when known, its creation FILETIME)
    /// is gone. `Some(true)`: no process has that PID, it has exited, or the PID now belongs to a
    /// process with a different birth. `Some(false)`: it is still running. `None`: the state
    /// cannot be verified (for example, access is denied), so evidence must be preserved.
    pub fn recorded_process_exited(pid: u32, created: Option<u64>) -> Option<bool> {
        if pid == 0 {
            return None;
        }
        let handle = unsafe { OpenProcess(0x1000 | 0x100000, 0, pid) };
        if handle.is_null() {
            return (unsafe { GetLastError() } == ERROR_INVALID_PARAMETER).then_some(true);
        }
        let process = Process {
            handle,
            pid,
            hash: |_| String::new(),
        };
        if unsafe { WaitForSingleObject(process.handle, 0) } == WAIT_OBJECT_0 {
            return Some(true);
        }
        let expected = created?;
        process.creation_time().ok().map(|actual| actual != expected)
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(
            handle: Handle,
            class: u32,
            buffer: *mut c_void,
            length: u32,
            required: *mut u32,
        ) -> i32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn CommandLineToArgvW(command: *const u16, count: *mut i32) -> *mut *mut u16;
    }

    pub struct Process {
        handle: Handle,
        pid: u32,
        hash: fn(&[String]) -> String,
    }
    // Windows process handles may move between threads. Access and close are
    // serialized by the owning runtime mutex; the handle is never duplicated here.
    unsafe impl Send for Process {}
    impl Drop for Process {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
    impl Process {
        pub fn open(pid: u32, hash: fn(&[String]) -> String) -> Result<Self, String> {
            let handle = unsafe { OpenProcess(0x1000 | 0x100000 | 1, 0, pid) };
            if handle.is_null() {
                return Err("Cannot open candidate process".into());
            }
            Ok(Self { handle, pid, hash })
        }
        pub fn creation_time(&self) -> Result<u64, String> {
            unsafe {
                let mut values: [FileTime; 4] = std::mem::zeroed();
                if GetProcessTimes(
                    self.handle,
                    &mut values[0],
                    &mut values[1],
                    &mut values[2],
                    &mut values[3],
                ) == 0
                {
                    return Err("Cannot query creation identity".into());
                }
                Ok((u64::from(values[0].high) << 32) | u64::from(values[0].low))
            }
        }
        fn arguments(&self) -> Result<Vec<String>, String> {
            unsafe {
                let mut required = 0;
                NtQueryInformationProcess(self.handle, 60, std::ptr::null_mut(), 0, &mut required);
                if required < std::mem::size_of::<UnicodeString>() as u32 || required > 131072 {
                    return Err("Cannot query command identity".into());
                }
                let mut storage =
                    vec![0usize; (required as usize + 7) / std::mem::size_of::<usize>()];
                if NtQueryInformationProcess(
                    self.handle,
                    60,
                    storage.as_mut_ptr().cast(),
                    required,
                    &mut required,
                ) < 0
                {
                    return Err("Cannot query command identity".into());
                }
                let value = &*storage.as_ptr().cast::<UnicodeString>();
                let start = storage.as_ptr() as usize;
                let end = start + storage.len() * std::mem::size_of::<usize>();
                let ptr = value.buffer as usize;
                if value.length == 0
                    || value.length % 2 != 0
                    || ptr < start
                    || ptr
                        .checked_add(value.length as usize)
                        .map_or(true, |p| p > end)
                {
                    return Err("Invalid command identity".into());
                }
                let mut command =
                    std::slice::from_raw_parts(value.buffer, value.length as usize / 2).to_vec();
                command.push(0);
                let mut count = 0;
                let argv = CommandLineToArgvW(command.as_ptr(), &mut count);
                if argv.is_null() {
                    return Err("Cannot parse command identity".into());
                }
                let mut args = Vec::new();
                for i in 0..count as usize {
                    let arg = *argv.add(i);
                    let mut length = 0;
                    while *arg.add(length) != 0 {
                        length += 1;
                    }
                    args.push(
                        std::ffi::OsString::from_wide(std::slice::from_raw_parts(arg, length))
                            .to_string_lossy()
                            .into_owned(),
                    );
                }
                LocalFree(argv.cast());
                Ok(args)
            }
        }
    }
    impl ProcessObject for Process {
        fn identity(&self) -> Result<Identity, String> {
            if unsafe { WaitForSingleObject(self.handle, 0) } != 258 {
                return Err("Candidate exited or is unverifiable".into());
            }
            let created = self.creation_time()?;
            let mut buffer = vec![0u16; 32768];
            let mut size = buffer.len() as u32;
            if unsafe { QueryFullProcessImageNameW(self.handle, 0, buffer.as_mut_ptr(), &mut size) }
                == 0
            {
                return Err("Cannot query executable identity".into());
            }
            let executable = std::ffi::OsString::from_wide(&buffer[..size as usize])
                .to_string_lossy()
                .into_owned();
            let command_hash = (self.hash)(&self.arguments()?);
            if unsafe { WaitForSingleObject(self.handle, 0) } != 258 {
                return Err("Candidate disappeared during validation".into());
            }
            Ok(Identity {
                pid: self.pid,
                created,
                executable,
                command_hash,
            })
        }
        fn terminate(&mut self) -> Result<(), String> {
            if unsafe { TerminateProcess(self.handle, 1) } == 0 {
                return Err("Termination failed; ownership retained".into());
            }
            Ok(())
        }
        fn wait(&self, timeout_ms: u32) -> Result<(), String> {
            if unsafe { WaitForSingleObject(self.handle, timeout_ms) } != 0 {
                return Err("Termination unconfirmed; ownership retained".into());
            }
            Ok(())
        }
    }
}
