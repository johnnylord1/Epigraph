//! The Core's TCP listener.
//!
//! The Core later spawns the Suwayomi JVM with redirected output, which on Windows inherits every
//! inheritable handle. A listener that leaked into the JVM kept the Core port bound after the Core
//! exited (seen with the 2026-08-30 Core), so the next Core could not start while that Suwayomi
//! lived. The standard library creates non-inheritable sockets; the test keeps it that way.

use std::net::{SocketAddr, TcpListener};

pub fn bind_core_listener(addr: SocketAddr) -> std::io::Result<TcpListener> {
    TcpListener::bind(addr)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    #[test]
    fn core_port_is_released_while_a_spawned_runtime_lives() {
        let listener = bind_core_listener("127.0.0.1:0".parse().unwrap()).unwrap();
        let addr = listener.local_addr().unwrap();
        // Redirected output makes the child inherit every inheritable handle, like the JVM.
        let mut child = Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        drop(listener);
        let rebound = TcpListener::bind(addr);
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            rebound.is_ok(),
            "the Core port stayed bound by a child process: {rebound:?}"
        );
    }
}
