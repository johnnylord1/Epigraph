use std::path::Path;

use anyhow::{bail, Context};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Aethon Core";

pub fn install(executable: &Path) -> anyhow::Result<()> {
    #[cfg(not(windows))]
    {
        let _ = executable;
        bail!("Aethon Core autostart is currently supported only on Windows");
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
            .context("failed to register Aethon Core current-user autostart")?;
        let persisted: String = key
            .get_value(RUN_VALUE)
            .context("failed to verify Aethon Core autostart registration")?;
        if persisted != command {
            bail!("Aethon Core autostart registry verification failed");
        }
        Ok(())
    }
}

pub fn remove(executable: &Path) -> anyhow::Result<bool> {
    #[cfg(not(windows))]
    {
        let _ = executable;
        bail!("Aethon Core autostart is currently supported only on Windows");
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
        let existing: String = match key.get_value(RUN_VALUE) {
            Ok(value) => value,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(error).context("failed to read Aethon Core autostart registration")
            }
        };
        if !registered_command_targets(&existing, executable) {
            bail!("refusing to remove Aethon Core autostart because it targets another executable");
        }
        key.delete_value(RUN_VALUE)
            .context("failed to remove Aethon Core autostart registration")?;
        Ok(true)
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
        let existing: String = match key.get_value(RUN_VALUE) {
            Ok(value) => value,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(error).context("failed to read Aethon Core autostart registration")
            }
        };
        Ok(registered_command_targets(&existing, executable))
    }
}

fn autostart_command(executable: &Path) -> anyhow::Result<String> {
    let raw = executable.to_string_lossy();
    if raw.contains('"') || raw.trim().is_empty() || !executable.is_absolute() {
        bail!("Aethon Core executable path cannot be registered safely");
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_command_is_quoted_and_uses_lan_serve_mode() {
        let executable = Path::new(r"C:\Users\Aethon User\AppData\Local\Aethon\aethon-syncd.exe");
        assert_eq!(
            autostart_command(executable).unwrap(),
            r#""C:\Users\Aethon User\AppData\Local\Aethon\aethon-syncd.exe" serve --lan"#
        );
        assert!(registered_command_targets(
            r#""C:\Users\Aethon User\AppData\Local\Aethon\aethon-syncd.exe" serve --lan"#,
            executable
        ));
    }

    #[test]
    fn autostart_remove_would_not_target_another_install() {
        let current = Path::new(r"C:\Users\me\AppData\Local\Aethon\aethon-syncd.exe");
        assert!(!registered_command_targets(
            r#""D:\Portable\Aethon\aethon-syncd.exe" serve --lan"#,
            current
        ));
    }
}
