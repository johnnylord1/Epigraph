# Suwayomi v2.3.2243 SR1 Baseline

## Scope

This is redacted Windows x64 evidence from Epigraph's empty-profile certification gate on 2026-07-27. It does not approve a production update and does not change `src-tauri/resources/suwayomi-compatibility.json`.

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

## SR7 Migration Certification

The SR1 empty-profile limitations were addressed by a separate SR7 run on
2026-07-27. The migration gate used Epigraph's bundled Temurin 21.0.8 runtime and
an allowlisted, read-only copy of the managed profile. It never started a JVM
against the original profile.

| Gate | Result |
| --- | --- |
| Original profile modified | No |
| Normalized Library state | 4 titles preserved |
| Normalized chapter state | 1,804 chapters; read, bookmark and progress state preserved |
| Categories | 2 preserved |
| Installed extension canaries | 4 preserved |
| Registered sources | 37 preserved |
| Installed content extension without a registered source | 0 |
| Extension Store migration | Legacy JSON URL canonicalized to the V23 protobuf store |
| V23 restart | Passed |
| V21 rollback | Passed |
| Residual candidate process or temporary root | None |

The four sequential phases took 9.9 s (V21 baseline), 18.9 s (V23 migration),
8.8 s (V23 restart), and 9.4 s (V21 rollback). The V23 working set sampled at
approximately 467 MiB initially and 464 MiB after restart. These values are
observations, not resource limits.

The report stores package and store URL hashes rather than names or private
configuration. Comix, Akuma and Webtoons were installed content canaries in the
profile; Tachidesk was treated as a helper. Mangakakalot, MangaClash and Asura
had artifacts on disk but were not marked installed by the profile, so this run
does not classify their websites as healthy or unhealthy.

This evidence certifies runtime compatibility, H2 migration, source
registration, Extension Stores, restart and rollback. It does not certify
website reachability, anti-bot behavior, login flows, or JCEF rendering. Those
remain explicit Level 1/Level 2 or external-service checks and are not inferred
from Level 0 structural health.

## SR9 Deterministic Extension Workflow

On 2026-07-28, the deterministic workflow gate passed with Epigraph's bundled
Temurin 21.0.8 runtime and disposable profiles only. The gate deliberately made
zero website requests.

| Gate | Result |
| --- | --- |
| Baseline runtime | `v2.1.1867`, checksum verified |
| Candidate runtime | `v2.3.2243`, checksum verified |
| Structural canary | Akuma `1.4.7` / version code `7` |
| Canary APK identity | Keiyoushi commit `c29058d23ef0e515a91acb70f92987ada1838846`, SHA-256 `a449e87e4636451d5f80a600366e07f621cdb8e231835d11abca136862015081` |
| Installation path | Official V21 `installExternalExtension`, followed by a stopped-profile V23 migration |
| Registered canary sources | 27 |
| Deterministic content provider | Suwayomi Local Source |
| Search, details, chapters and pages | Passed |
| Candidate restart | Passed with stable source, manga and chapter identities |
| Structural error scan | No ABI, classloader, Kotlin, serialization or OkHttp errors |
| Residual JVM/profile | None |

The APK is the pinned source artifact. The JAR generated by the official V21
Extension Manager is recorded diagnostically because ZIP metadata makes that
derived byte stream non-reproducible; it is not used as the artifact identity.
The V23 candidate loads it only through the supported profile-migration path.

Direct upload of the migrated JAR through V23 `installExternalExtension` raised
an upstream `NullPointerException` while parsing the Android manifest. That JAR
path remains unsupported. A follow-up SR11 proof pinned the original Akuma
`1.4.10` APK from Keiyoushi commit
`4aee126a1b34faa4224ba1646585712d9bee043a`, verified SHA-256
`3ae4751efb075495235f67233b14c0207d921cf00d214736a5d23a6e23450aaa`,
and submitted those exact bytes through the official V23
`installExternalExtension` operation. Suwayomi performed its own supported APK
handling, registered 27 sources and preserved the same package, version and
source IDs after restart. Epigraph does not convert APKs or edit extension files.

Live sources remain observational. The deterministic gate does not infer
website health, Cloudflare behavior, authentication or parser compatibility.

## SR11 Transactional Extension Updates

On 2026-07-28, automatic manga-extension updates were moved behind
`ExtensionUpdateCoordinator` and a native, single-batch transaction.

- Update metadata and artifact URLs come from the active Suwayomi Extension
  Store inventory. Automatic activation requires credential-free HTTPS store
  provenance; manual artifacts are not silently promoted.
- Artifacts stream sequentially to a bounded temporary directory (64 MiB per
  artifact). The renderer does not download or retain APK/JAR bytes.
- The current runtime is drained and stopped before the H2/profile snapshot.
  The candidate receives only the validated snapshot allowlist and runs with
  `maxSourcesInParallel = 1`.
- Exact APK/JAR bytes are installed only through Suwayomi's official
  `installExternalExtension` operation. Registration is polled for at most 15
  seconds because GraphQL readiness can precede Extension Manager readiness.
- Suwayomi v2.3 lists the installed `versionName`/`versionCodeLong` of an
  extension with an update, while its artifact URL already serves the new
  version. The first install of the staged bytes in the candidate therefore
  learns the artifact's identity: same package, version code not older than
  the installed one and, when the file name declares a version in the
  Tachiyomi convention (`...-v1.6.49.jar`), that same version name. Every later
  install of those bytes (staging rebuild, activation, restart checks) must
  report exactly that identity, and the evidence carries it.
- Evidence states whether its identity was confirmed. An artifact that fails
  before declaring its version still carries the pre-update version, so it is
  reported as rejected but no compatibility is recorded under that version.
- An artifact that cannot be downloaded or staged rejects only its own update
  as `ARTIFACT_UNAVAILABLE`, with no artifact digest; nothing about its
  compatibility is recorded and the user is told the download failed. A
  dropped connection or a store server error gets one more try first; a missing
  artifact does not. When no artifact stages, the runtime is not
  stopped. Malformed or unsafe items (incomplete metadata, a non-HTTPS URL)
  still refuse the whole batch before anything is downloaded.
- Approved artifacts are activated as one logical batch. Any activation or
  source-identity divergence restores the runtime profile snapshot before
  maintenance is released.
- A separate atomic journal covers `PREPARED`, `SNAPSHOT_CREATED`,
  `CERTIFYING`, `ACTIVATING`, `COMMITTED`, `ROLLBACK_RUNNING` and
  `ROLLED_BACK`. Startup recovery restores an incomplete batch before spawning
  the managed runtime.
- Compatibility evidence is versioned per profile and keyed by profile,
  package, version code, artifact hash, store, runtime version and runtime JAR
  hash. Persisted failures use stable codes and do not contain private paths,
  URLs, credentials or exception text.

The deterministic workflow passed exact V23 install/restart, the V21-to-V23
profile workflow, search, details, chapters and pages with zero website source
requests and no residual JVM. Live website health remains outside this gate.

The final readiness gate was subsequently increased to bounded polling for at
most 45 seconds after restart. This addresses slow Extension Manager
registration without increasing worker, JVM, or source concurrency.

## SR12 Managed Source Boundary

On 2026-07-28, active manga search, details, chapters, and pages were moved
behind `SourceRuntime/SuwayomiAdapter`.

- Profiles V21 and V23 share transport, retry, redaction, and typed error
  handling.
- Component, Library Update, migration, reconciliation, Reader, and cache
  consumers use typed source-operation DTOs rather than live GraphQL documents.
- A static gate rejects active scraping operations outside the runtime adapter.
- GraphQL remains available internally for administrative state such as
  categories, tracking, downloads, and extension inventory.
- Store URL canonicalization is conservative and never merges distinct path or
  query values.

No Library identity, source ID, progress, bookmark, category, download, or
pagination contract was changed.

## SR13 Anti-bot And Lifecycle Gate

On 2026-07-28, FlareSolverr eligibility and lifecycle controls passed the
deterministic gate.

- Manga errors must contain confirmed anti-bot evidence. ABI/classloader,
  serialization, obsolete source, parser, authentication, 404, and ordinary
  network failures remain ineligible.
- For manga extensions, Suwayomi remains the only runtime that requests
  websites through FlareSolverr. The Epigraph controller performs only the local
  `sessions.list` health probe.
- The local backend has atomic ownership identity and a Windows Job Object with
  kill-on-close. Unknown or externally owned processes are not adopted or
  terminated.
- The Docker backend is pinned by image digest, loopback-only, single-CPU,
  1-GiB, 256-process, and no-restart policy.
- Lifecycle operations are serialized in-process and cross-process. Cleanup
  failures are explicit.

The real Docker container lifecycle was not exercised because Docker CLI was
unavailable. Deterministic policy tests passed; a real Docker lifecycle remains
conditional evidence.
