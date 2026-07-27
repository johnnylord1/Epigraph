# Suwayomi v2.3.2243 SR1 Baseline

## Scope

This is redacted Windows x64 evidence from Aethon's empty-profile certification gate on 2026-07-27. It does not approve a production update and does not change `src-tauri/resources/suwayomi-compatibility.json`.

The run used a disposable operating-system temporary directory and did not read, copy, or modify the managed user profile. The temporary runtime was removed after both phases.

## Artifact

| Field | Value |
| --- | --- |
| Version | `v2.3.2243` |
| Asset | `Suwayomi-Server-v2.3.2243.jar` |
| Size | 174,128,768 bytes |
| Published SHA-256 | `821141b32e170d4a02d3cbdfed577ed8f07bd22383ff5f4132ebb5ae40e98dd5` |
| Manifest version | `v2.3.2243` |
| Platform | Windows x64 |
| Local Java used | Temurin `25.0.1` |
| Result | Passed |

CI must repeat the same gate with its pinned Java 21 runtime before this evidence can support an allowlist review.

## GraphQL Baseline

| Field | Value |
| --- | --- |
| Canonical schema SHA-256 | `ce2a5b0a0a4d6fb22d8ca243479e2f93478062bbd47b5f431a05f787be438c94` |
| Canonical schema size | 269,165 bytes |
| Types | 364 |
| Query fields | 33 |
| Mutation fields | 80 |
| Required queries | `mangas`, `sources`, `extensions` |
| Semantic contract | Passed |
| Restart schema stability | Passed |

Descriptions and source ordering are excluded from the canonical representation. This hash is diagnostic; compatibility is decided by required fields and health payloads.

## Observed Capabilities

| Capability | Observed in GraphQL | Evidence summary |
| --- | --- | --- |
| Extension Stores | Yes | Extension Store types and queries |
| Legacy extension repositories | Yes | `extensionRepos` settings fields |
| Extension installation | Yes | `installExternalExtension` |
| Extension update | Yes | `updateExtension`, `updateExtensions` |
| Extension uninstall mutation | No | No matching root mutation |
| Source preferences | Yes | `updateSourcePreference` and preference types |
| WebView operation | No | No matching GraphQL field |

`No` means that the capability was not represented by a matching GraphQL field. It does not prove that the Suwayomi runtime or JCEF lacks the underlying behavior.

## Process Samples

| Phase | Startup/health | Attempts | Working set | Private memory | Virtual memory | Threads | CPU |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial | 13.9 s | 13 | 499.5 MiB | 530.8 MiB | 6.30 GiB | 77 | 41.44 s |
| Restart | 11.7 s | 11 | 488.6 MiB | 520.5 MiB | 6.30 GiB | 77 | 38.83 s |

The virtual-memory value is address space, not committed resident memory. These samples are descriptive and are not resource limits or compatibility thresholds.

## Remaining SR1 Limits

- The profile was empty; no real H2 migration or installed-extension compatibility was tested.
- Network access was not blocked at the operating-system level.
- The disposable-profile baseline runs the checksum-verified official JAR under the current user. It now verifies that the dynamic loopback listener belongs to the launched PID, but it is not an OS sandbox and is not promotion evidence.
- WebView2 and JCEF were not exercised.
- The gate emits `compatibility-review.json` with `promotionEligible: false`; it no longer emits an allowlist-shaped candidate.
