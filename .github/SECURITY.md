# Security policy

## Supported versions

Security fixes target the latest published desktop release and the current `main` branch. Older development builds are not maintained.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| `main` | Yes |
| Older builds | No |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use the repository's **Security** tab to create a private security advisory. Include:

- the affected version and platform;
- clear reproduction steps;
- the expected and observed behavior;
- the potential impact;
- logs or screenshots with tokens, profile data, and personal information removed.

Please allow time for triage before disclosing details publicly. The maintainer will acknowledge the report, assess its scope, and coordinate a fix and release when the issue is confirmed.

## Sensitive areas

Pairing credentials, updater signing material, tracker tokens, source cookies, profile databases, backup archives, and Syncd authentication data must never be attached to an issue or committed to the repository.
