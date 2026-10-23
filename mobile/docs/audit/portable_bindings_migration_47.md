# Portable bindings migration 47

## Scope

Migration 47 introduces the V3 portable work/chapter bindings, dependency
records and resumable bootstrap checkpoints. It preserves every V2 identity,
binding, outbox row and cached Library record.

Portable identity is provider-owned and opaque:

- comics: exact decimal `sourceId` plus exact manga key;
- novels: exact `pluginId` plus exact novel key;
- chapters: the parent portable work plus the exact chapter key.

Local database IDs, titles, APK/JAR identity and repository trust are not part
of the V3 identity.

## Upgrade and rollback

- The migration is additive and does not rewrite V2 rows.
- Upgrade fixtures cover the previous schema and the migrated schema.
- A rollback build may ignore the new tables while continuing to read all V2
  data; it must not delete the V3 tables or claim that pending V3 state was
  applied.
- Reinstall/downgrade remains a backup-and-restore operation because SQLDelight
  does not execute reverse migrations automatically.
- Corrupt or unprovable Legacy identities stay `LEGACY_UNBOUND`; no title match
  or guessed provider URL is allowed.

## Runtime behavior

The app imports a complete paginated manifest transactionally, resolves
dependencies through existing managers and hydrates independent source queues
with bounded concurrency. Pending chapter state is retained until an exact
chapter binding is available. Disconnecting or disabling a domain preserves
bindings, Library data and offline assets.

The sync pass never calls an extension. When a bound comic lacks a chapter the
manifest has state for, the pass leaves the chapter `PENDING_PROVIDER` /
`CHAPTER_NOT_FOUND` and asks `PortableChapterPrefetchWorker` for a background
fetch. The worker lists those comics' chapters with the library update's own
path (`refreshChapterList` + `syncChaptersWithSource`), most recently read
first. Each run is bounded:

- at most 30 titles;
- two sources at once, one title at a time per source;
- 45 s per title and an 8 min run deadline;
- a title waits 12 h after a fetch and 1 h after a failure.

It needs a network and no low battery, stands down while sync is disconnected
or a library update runs, and wakes the Core sync after adding chapters so they
bind and take their desktop state. It reads one SQL query and changes no schema.
Rollback: pass no chapter materializer to `MihonPortableProvider` in the sync
module; pending chapters then wait for the user to open or update the title.

Before any extension call, the worker reads the chapter lists the paired
desktop's Suwayomi already holds through the Core `catalog` route
(`CoreChapterListStage`): one Core session per run, four readers, 30 s per
title, matched to the desktop library by exact source ID and manga key, with
Suwayomi IDs used only within that session. Each list goes through
`syncChaptersWithSource`, which keeps chapters already stored on the phone, and
the desktop read state in the same response is folded in under the existing
bridged rules (it never un-reads a chapter), with a Core request only when the
identity differs. A title the desktop does not list, or whose list fails, waits
10 minutes before the desktop is asked again and falls back to the extension
path above. Rollback: pass no `CoreChapterListStage` to the prefetcher.

The import validates that every work points to an existing dependency and that
the dependency declares the work's exact source ID. Trust is retained only while
the Store/repository provenance remains unchanged. A changed origin returns to
`APPROVAL_REQUIRED`; trust never arrives through Syncd.

Reader progress checks V3 bindings before Legacy identity tables. A V3-only
work can therefore publish progress, but only when both exact work and chapter
refs are available. Partial refs are not downgraded into a guessed V2 mutation.
Bootstrap completion accounts for pending works, pending chapters and required
user action; those states finish as `PARTIAL`, not as a false success.

Provider keys remain byte-for-byte opaque, but keys carrying URL userinfo or
known credential query names are not portable. They are rejected rather than
normalized so tokens, cookies and signed credentials cannot cross Syncd.
Extension Store and LNReader repository references in V3 must be canonical
public HTTPS indexes without userinfo, query, fragment, loopback, LAN or local
hostnames. This does not prohibit a user from configuring a private repository
locally; it only prevents that origin from being transmitted as trust or
provenance to another device.

No automatic V2 backfill was added to migration 47. Existing rows remain fully
readable and unprovable identities remain Legacy. This is intentional: the
migration cannot derive an opaque provider key from a title or a local primary
key without violating the V3 contract.

The follow-up checkpoint migration 49 separates comics and novels bootstrap
progress so one ecosystem cannot advance, expire or replace the other one's
snapshot cursor. Snapshot identity, fingerprint and expiry are persisted for
resume; stale Library memberships are removed only after the final page of the
same immutable snapshot has committed.

Continuous V3 mutations carry portable work/chapter refs for Library
membership, categories and chapter state. When an exact V3 binding exists, the
mobile publishes the causal Core mutation only; it does not also enqueue the
same cross-device state directly for Suwayomi. Legacy records keep their prior
path. A bound hydrated work is marked as a local favorite in the binding
transaction, which keeps it visible when credentials are removed or pairing is
unavailable.

The modern Suwayomi contract uses Extension Stores. `pkgName` resolves an
extension, while each required decimal `sourceId` must be enumerated and loaded
before the dependency is ready. LNReader uses `pluginId` as logical identity;
its repository and observed artifact hash are provenance only. Neither model
uses APK, JAR or JavaScript as protocol identity.

## Verification

Run with one worker:

```text
gradlew verifySqlDelightMigration --max-workers=1
gradlew :domain:testAndroidHostTest :data:testAndroidHostTest --max-workers=1
gradlew :app:testDevDebugUnitTest --tests "epigraph.sync.core.portable.*" --max-workers=1
```

Verified on 13/08/2026:

- migration fixtures 47 and 48 compile through SQLDelight;
- trust preservation/change, package-to-source validation, pending chapters and
  partial bootstrap are covered by focused app tests;
- provider adapters preserve exact opaque keys and isolate source queues;
- reader progress is covered with V3-only comic and novel bindings.
- secret-bearing provider refs and private dependency indexes are rejected by
  contract tests while ordinary opaque query parameters remain unchanged.
- combined provider, hydration, manifest, projection and outbox coverage passes
  38 focused app tests; the deterministic desktop manifest gate passes 16 tests
  per applicable Rust target.
- `assembleDevDebug` and `assembleStandardRelease` succeed; Android lint currently crashes inside the
  upstream `ExperimentalDetector` while analyzing Kotlin and did not emit an
  application diagnostic.
- The current dev APK was installed in the disposable Android emulator and
  migrated the real profile database from schema 43 to `user_version 50`.
- A single Core worker completed successfully against the rebuilt desktop
  sidecar, with no unsupported-client, fatal or SQLite error in the observed
  window.
- A consistent `db + wal + shm` snapshot contained 631 portable comic refs,
  all classified without starvation, plus 631 favorite Library rows and 631
  cover URLs. The rendered Library showed real covers from disk cache.
- The active Suwayomi V21 runtime cannot publish Extension Stores. Missing
  provenance is therefore eligible only for locally trusted provider lookup;
  it never grants repository trust or installs an artifact. Explicit unknown
  V23 Store/repository provenance still requires approval.
- Unchanged manifests preserve pending resolution evidence. Hydration remains
  bounded to 1,000 refs per pass and two concurrent source queues, which covers
  the observed 631-item Library without increasing per-source concurrency.
- Focused manifest and hydration tests pass after these corrections. The
  devDebug APK rebuild and real worker smoke also pass.
- A physical-device pairing, explicit Store/repository approval, Package
  Installer flow, unpair/re-pair cycle and two-device causal convergence remain
  release evidence gates; they were not inferred from the emulator smoke.
