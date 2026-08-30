use std::path::Path;

use anyhow::{bail, Context};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Epigraph Core";
const LEGACY_RUN_VALUE: &str = "Aethon Core";

pub fn install(executable: &Path) -> anyhow::Result<()> {
    #[cfg(not(windows))]
    {
        let _ = executable;
        bail!("Epigraph Core autostart is currently supported only on Windows");
    }

    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
        use winreg::RegKey;

        let command = autostart_command(executable)?;
        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = current_user
            .create_subkey_with_flags(RUN_KEY, KEY_READ | KEY_WRITE)
            .context("failed to open current-user Run registry key")?;
        key.set_value(RUN_VALUE, &command)
            .context("failed to register Epigraph Core current-user autostart")?;
        let persisted: String = key
            .get_value(RUN_VALUE)
            .context("failed to verify Epigraph Core autostart registration")?;
        if persisted != command {
            bail!("Epigraph Core autostart registry verification failed");
        }
        let legacy_executable = executable.with_file_name("aethon-syncd.exe");
        if let Ok(legacy_command) = key.get_value::<String, _>(LEGACY_RUN_VALUE) {
            if registered_command_targets(&legacy_command, &legacy_executable)
                || legacy_command_targets_aethon(&legacy_command)
            {
                let _ = key.delete_value(LEGACY_RUN_VALUE);
            }
        }
        Ok(())
    }
}

pub fn remove(executable: &Path) -> anyhow::Result<bool> {
    #[cfg(not(windows))]
    {
        let _ = executable;
        bail!("Epigraph Core autostart is currently supported only on Windows");
    }

    #[cfg(windows)]
    {
        use std::io::ErrorKind;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
        use winreg::RegKey;

        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        let key = match current_user.open_subkey_with_flags(RUN_KEY, KEY_READ | KEY_WRITE) {
            Ok(key) => key,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(error).context("failed to open current-user Run registry key")
            }
        };
        let mut removed = false;
        match key.get_value::<String, _>(RUN_VALUE) {
            Ok(existing) => {
                if !registered_command_targets(&existing, executable) {
                    bail!("refusing to remove Epigraph Core autostart because it targets another executable");
                }
                key.delete_value(RUN_VALUE)
                    .context("failed to remove Epigraph Core autostart registration")?;
                removed = true;
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).context("failed to read Epigraph Core autostart registration")
            }
        }
        let legacy_executable = executable.with_file_name("aethon-syncd.exe");
        if let Ok(existing) = key.get_value::<String, _>(LEGACY_RUN_VALUE) {
            if registered_command_targets(&existing, &legacy_executable)
                || legacy_command_targets_aethon(&existing)
            {
                key.delete_value(LEGACY_RUN_VALUE)
                    .context("failed to remove legacy Core autostart registration")?;
                removed = true;
            }
        }
        Ok(removed)
    }
}

pub fn is_registered(executable: &Path) -> anyhow::Result<bool> {
    #[cfg(not(windows))]
    {
        let _ = executable;
        Ok(false)
    }

    #[cfg(windows)]
    {
        use std::io::ErrorKind;
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
        use winreg::RegKey;

        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        let key = match current_user.open_subkey_with_flags(RUN_KEY, KEY_READ) {
            Ok(key) => key,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(error).context("failed to open current-user Run registry key")
            }
        };
        let canonical = key
            .get_value::<String, _>(RUN_VALUE)
            .map(|existing| registered_command_targets(&existing, executable))
            .unwrap_or(false);
        let legacy_executable = executable.with_file_name("aethon-syncd.exe");
        let legacy = key
            .get_value::<String, _>(LEGACY_RUN_VALUE)
            .map(|existing| {
                registered_command_targets(&existing, &legacy_executable)
                    || legacy_command_targets_aethon(&existing)
            })
            .unwrap_or(false);
        Ok(canonical || legacy)
    }
}

fn autostart_command(executable: &Path) -> anyhow::Result<String> {
    let raw_path = executable.to_string_lossy();
    #[cfg(windows)]
    let raw = raw_path
        .strip_prefix(r"\\?\UNC\")
        .map(|path| format!(r"\\{path}"))
        .unwrap_or_else(|| {
            raw_path
                .strip_prefix(r"\\?\")
                .unwrap_or(&raw_path)
                .to_string()
        });
    #[cfg(not(windows))]
    let raw = raw_path.to_string();
    if raw.contains('"') || raw.trim().is_empty() || !executable.is_absolute() {
        bail!("Epigraph Core executable path cannot be registered safely");
    }
    Ok(format!("\"{raw}\" serve --lan"))
}

fn registered_command_targets(command: &str, executable: &Path) -> bool {
    let Ok(expected) = autostart_command(executable) else {
        return false;
    };
    #[cfg(windows)]
    {
        command.eq_ignore_ascii_case(&expected)
    }
    #[cfg(not(windows))]
    {
        command == expected
    }
}

/// Recognize the old product-wide autostart entry during a rebrand migration.
///
/// The legacy entry can point at a separate `%LOCALAPPDATA%\\Aethon` install,
/// so checking only for a sibling binary beside the new executable leaves the
/// old Core running at login.  Keep the match deliberately narrow: only a
/// quoted/unquoted `aethon-syncd.exe` directly inside an `Aethon` directory is
/// eligible for removal.
fn legacy_command_targets_aethon(command: &str) -> bool {
    let trimmed = command.trim();
    let raw_path = if let Some(rest) = trimmed.strip_prefix('"') {
        rest.split_once('"').map(|(path, _)| path)
    } else {
        trimmed.split_whitespace().next()
    };
    let Some(raw_path) = raw_path else {
        return false;
    };
    let path = Path::new(raw_path);
    let is_local_app_data = raw_path
        .replace('/', "\\")
        .to_ascii_lowercase()
        .contains("\\appdata\\local\\");
    let is_legacy_binary = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("aethon-syncd.exe"));
    let is_legacy_install = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("Aethon"));
    is_local_app_data && is_legacy_binary && is_legacy_install
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_command_is_quoted_and_uses_lan_serve_mode() {
        let executable =
            Path::new(r"C:\Users\Epigraph User\AppData\Local\Epigraph\epigraph-syncd.exe");
        assert_eq!(
            autostart_command(executable).unwrap(),
            r#""C:\Users\Epigraph User\AppData\Local\Epigraph\epigraph-syncd.exe" serve --lan"#
        );
        assert!(registered_command_targets(
            r#""C:\Users\Epigraph User\AppData\Local\Epigraph\epigraph-syncd.exe" serve --lan"#,
            executable
        ));
    }

    #[test]
    fn autostart_remove_would_not_target_another_install() {
        let current = Path::new(r"C:\Users\me\AppData\Local\Epigraph\epigraph-syncd.exe");
        assert!(!registered_command_targets(
            r#""D:\Portable\Epigraph\epigraph-syncd.exe" serve --lan"#,
            current
        ));
    }

    #[test]
    fn legacy_autostart_command_is_checked_against_the_legacy_sibling_binary() {
        let canonical = Path::new(r"C:\Users\me\AppData\Local\Epigraph\epigraph-syncd.exe");
        let legacy = canonical.with_file_name("aethon-syncd.exe");
        assert!(registered_command_targets(
            r#""C:\Users\me\AppData\Local\Epigraph\aethon-syncd.exe" serve --lan"#,
            &legacy
        ));
        assert!(!registered_command_targets(
            r#""D:\Other\Aethon\aethon-syncd.exe" serve --lan"#,
            &legacy
        ));
    }

    #[test]
    fn legacy_product_autostart_is_migrated_even_when_it_uses_a_separate_install() {
        assert!(legacy_command_targets_aethon(
            r#""C:\Users\me\AppData\Local\Aethon\aethon-syncd.exe" serve --lan"#
        ));
        assert!(legacy_command_targets_aethon(
            r#""C:\Users\me\AppData\Local\Packages\OpenAI.Codex\LocalCache\Local\Aethon\aethon-syncd.exe" serve --lan"#
        ));
        assert!(!legacy_command_targets_aethon(
            r#""D:\Other\Aethon\aethon-syncd.exe" serve --lan"#
        ));
        assert!(!legacy_command_targets_aethon(
            r#""C:\Users\me\AppData\Local\Epigraph\aethon-syncd.exe" serve --lan"#
        ));
        assert!(!legacy_command_targets_aethon(
            r#""C:\Users\me\AppData\Local\Aethon\aethon.exe" serve --lan"#
        ));
    }

    #[cfg(windows)]
    #[test]
    fn autostart_command_removes_verbatim_windows_prefixes() {
        assert_eq!(
            autostart_command(Path::new(
                r"\\?\C:\Users\Epigraph User\AppData\Local\Epigraph\epigraph-syncd.exe",
            ))
            .unwrap(),
            r#""C:\Users\Epigraph User\AppData\Local\Epigraph\epigraph-syncd.exe" serve --lan"#,
        );
        assert_eq!(
            autostart_command(Path::new(r"\\?\UNC\server\share\epigraph-syncd.exe")).unwrap(),
            r#""\\server\share\epigraph-syncd.exe" serve --lan"#,
        );
    }
}
