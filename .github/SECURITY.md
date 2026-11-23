# Security policy

## Supported versions

Security fixes target the latest published release for each platform and the current `main` branch. The public repository contains the Android project under `mobile/`; the Android source on `main` is in scope alongside the desktop app and Core/Syncd services.

| Surface | Supported |
| --- | --- |
| Latest desktop release | Yes |
| Latest Android release | Yes |
| Current `main` branch, including `mobile/` | Yes |
| Older releases and development builds | No |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use the repository's **Security** tab to create a private security advisory. Include:

- the affected version and platform;
- for Android reports, the app version, Android version, and device model;
- clear reproduction steps;
- the expected and observed behavior;
- the potential impact;
- logs or screenshots with tokens, profile data, and personal information removed.

Please allow time for triage before disclosing details publicly. The maintainer will acknowledge the report, assess its scope, and coordinate a fix and release when the issue is confirmed.

## Sensitive areas

Pairing credentials, updater signing material, tracker tokens, source cookies, plugin or source credentials, profile databases, backup archives, and Syncd authentication data must never be attached to an issue or committed to the repository.
