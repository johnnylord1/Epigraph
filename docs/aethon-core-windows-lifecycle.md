# Aethon Core Windows lifecycle

The Windows Core is a current-user daemon. Closing the Aethon desktop window only detaches the desktop client; it does not terminate a persistent Core.

## Commands

- `aethon-syncd.exe serve --lan` starts the persistent LAN Core.
- `aethon-syncd.exe shutdown --reason <manual|restart|pre-update|uninstall>` performs an authenticated shutdown and waits for the process to exit.
- `aethon-syncd.exe autostart install|remove|status` manages only `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Aethon Core`.

The shutdown client reads `runtime.json`, pins its TLS certificate fingerprint, verifies the discovery descriptor's `serverId`, obtains a loopback-only local-authority token, submits the expected PID, and waits for both the manifest and process to disappear. The server stops mDNS, drains Axum with a bounded grace period, and closes SQLite before releasing the runtime manifest and process lock.

No command deletes the Core database, certificates, paired-device state, imported content, downloads, or Suwayomi data.

## Installer behavior

`src-tauri/windows/aethon-core-hooks.nsh` is configured as the Tauri NSIS installer hook file. Pre-update and pre-uninstall stop the identified Core and Aethon-owned Suwayomi processes before installed binaries are changed. Failure aborts before file replacement or removal. Post-install registers current-user autostart and starts the Core; an autostart registration failure is logged but does not roll back an otherwise valid installation.

The release gate is:

```powershell
pnpm syncd:prepare-sidecar:release
pnpm tauri:build
```

The sidecar preparation step builds the release binary, verifies it is not a placeholder, runs a command-line smoke check, and copies the target-triple binary expected by Tauri.

## Suwayomi ownership boundary

At startup, Core can attach lifecycle metadata for an already-running Suwayomi whose `server.owner.json`, loopback endpoint, PID, Java executable, and exact `rootDir` argument agree. During update/uninstall it stops only such validated owned processes.

Starting Suwayomi when no owned instance exists is not yet available in the headless Core. The spawn and bundled-runtime resolver remain coupled to the Tauri desktop `AppHandle`; they must be extracted into a shared backend module before Core autostart can guarantee comics online immediately after Windows login without the desktop having launched at least once.
