# Novel Runtime syncd Integration

## Summary

Epigraph integrates novels runtime state into the existing Syncd model without widening sync semantics.

The existing scope rules remain authoritative:
- novels are `novels:profile:<id>`
- books are `books:global`

## Primary scope references

Confirmed against:
- [mutations.rs](../src-tauri/src/syncd/routes/mutations.rs)
- [middleware.rs](../src-tauri/src/syncd/middleware.rs)
- [0001_init.sql](../src-tauri/migrations-syncd/0001_init.sql)
- [contracts.ts](../src/lib/novels/contracts.ts)

## What novels sync in v1

Under `novels:profile:<id>`:
- library entries
- progress
- bookmarks
- history
- repository metadata snapshot
- installed plugin metadata snapshot
- available source id snapshot
- explicitly whitelisted plugin settings metadata

## What novels do not sync in v1

- chapter HTML or text
- downloaded chapter content
- plugin artifact files
- cookies
- tokens
- credentials
- arbitrary plugin web storage
- any non-whitelisted secret-bearing plugin state

## What books keep doing

Under `books:global`:
- library metadata
- progress
- bookmarks

Books file assets remain outside sync v1.

## Snapshot whitelist rule

`novel.source_snapshot` must be sanitized before sync.

Allowed:
- repository URLs
- plugin ids
- plugin versions
- enabled state
- minimal trust state
- explicitly whitelisted plugin settings

Denied:
- cookies
- tokens
- credentials
- arbitrary web storage
- secrets

## Integration flow

1. novels runtime state changes
2. domain normalizes change into sync-safe entity
3. entity is scoped to `novels:profile:<id>`
4. syncd mutation and replay proceed through the existing contract
5. replay hydrates only the matching profile scope

## No profile leakage

Novels runtime state must never leak across profiles:
- repo lists
- installed plugin sets
- plugin settings
- library entries
- progress
- bookmarks
- history

Books remain global and intentionally separate from novels profile scope.

## Current status

Reviewed on `2026-07-28`.

- Scope validation, novel/book mutation handling, snapshots, replay, tombstone
  behavior, reconnect, pause/resume, and two-instance desktop scenarios are
  covered by the current Rust and WebView2 gates.
- Syncd remains part of EpigraphCore and continues to replicate repository and
  plugin snapshot metadata allowed by this contract.
- Chapter content, plugin binaries, cookies, tokens, credentials, and arbitrary
  plugin storage remain excluded.
- Harness port/process concurrency is future automation work and must not
  narrow the production scopes for comics, novels, or books.

## Mobile boundary

The Epigraph Mobile client uses the same Core/Syncd scopes after pairing:
`novels:profile:<id>` for novel metadata/state and `books:global` for books.
Chapter HTML, plugin binaries, cookies, tokens, credentials, and arbitrary
plugin storage remain local in both clients. Comics are intentionally not part
of this LNReader scope; their catalog and chapter state come from the hosted
Suwayomi profile through the Core proxy.

## Extension authority and mobile reconciliation

Reviewed against the upstream documentation on `2026-08-10`:

- Suwayomi owns comic extension stores, installation, source registration and
  scraping. The Epigraph Core exposes only the loaded extension/source inventory;
  it does not publish extension artifacts through Syncd.
- LNReader repositories publish JavaScript plugin descriptors through
  `plugins.min.json`. Novel repository and plugin records in Syncd are
  declarative profile state, not executable payloads.
- The Android client resolves comic parity from
  `/v1/suwayomi/extensions`. Any equivalent APK is obtained from the Android
  client's trusted Mihon repository and still uses the visible Package
  Installer flow.
- The Android client resolves novel requirements only from the repository URL
  recorded by `novel.repository`, using its existing `NovelPluginManager`.
  It downloads JavaScript from that LNReader repository and verifies the Core
  record's SHA-256 and byte length before loading it. An already installed
  plugin is reused only when its version and local bytes match the same
  evidence; otherwise the exact repository artifact is resolved again.
- Syncd never transfers JAR, APK or JavaScript bytes. A missing, changed or
  ambiguous plugin remains pending and cannot remove Library records or local
  plugins.
- Writing `repositories-state.json` publishes the enabled LNReader repository
  and installed-plugin evidence to the hosted Core. Existing state is also
  published when the local Core authority starts, so plugins installed before
  pairing are not omitted.
- Plugin evidence contains repository identity, plugin/source identity,
  version, SHA-256 and byte length. The Core does not require or persist the
  executable JavaScript blob; Android fetches the matching entry from the exact
  LNReader index and verifies that evidence before activation.
- Desktop replay acknowledges `novel.repository` and `novel.plugin` records
  without installing executable code from Syncd. Local LNReader repository
  management remains the desktop installation boundary.

Primary references:

- https://github.com/Suwayomi/Suwayomi-Server/wiki/Getting-Extensions
- https://github.com/Suwayomi/Suwayomi-Server/wiki/Configuring-Suwayomi%E2%80%90Server
- https://github.com/Suwayomi/Suwayomi-Server/blob/master/CONTRIBUTING.md
- https://github.com/lnreader/lnreader-plugins
