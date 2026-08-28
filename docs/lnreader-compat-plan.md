# LNReader Compatibility Plan

## Summary

Epigraph will integrate with the existing LNReader repository and plugin ecosystem directly.
It will not invent a new novels plugin format, and it will not collapse plugin runtime concerns into the shared reader surface.

This document freezes the architecture for the desktop-first novels/books reader program and records the exact primary sources audited on April 8, 2026.

## Implementation Status

Reviewed on `2026-07-28`.

- The LNReader-compatible repository catalog, isolated runtime host, action
  whitelist, source browsing, details, chapter loading, Library state, backup,
  migration checks, and Syncd metadata contracts are implemented.
- `source.settings.read` remains available on demand.
  `source.settings.write` is intentionally not exposed.
- The runtime continues to consume final published plugin artifacts. It does
  not execute upstream multisrc build tooling and does not define a proprietary
  Epigraph plugin format.
- Live website compatibility remains observational and is tracked separately
  in `lnreader-source-compatibility-matrix.md`.

## Primary Sources

Audit date: `2026-04-08`

### LNReader contract

1. `README`
   - URL: `https://raw.githubusercontent.com/LNReader/lnreader-plugins/master/README.md`
   - Used for:
     - published repository URL shape
     - plugin repository distribution expectations
   - Confirmed against Epigraph:
     - repository management must be separate from Suwayomi extension repositories
     - the Epigraph novels flow must consume a published LNReader repository directly

2. `Plugin docs`
   - URL: `https://raw.githubusercontent.com/LNReader/lnreader-plugins/master/docs/docs.md`
   - Used for:
     - plugin method contract
     - filters contract
     - plugin settings contract
   - Confirmed against Epigraph:
     - novels runtime must stay separate from the reader shell
     - Epigraph needs compatibility shims instead of a proprietary plugin API

3. `Plugin template`
   - URL: `https://raw.githubusercontent.com/LNReader/lnreader-plugins/master/docs/plugin-template.ts`
   - Used for:
     - exported plugin shape in practice
     - `resolveUrl` behavior
     - `path`-based source semantics
   - Confirmed against Epigraph:
     - Epigraph should normalize plugin outputs into app domain models instead of forcing plugins into EPUB-like flows

4. `Plugin types`
   - URL: `https://raw.githubusercontent.com/LNReader/lnreader-plugins/master/src/types/plugin.ts`
   - Used for:
     - canonical `PluginItem`, `Plugin`, `NovelItem`, `SourceNovel`, `ChapterItem`
     - optional `parsePage` capability
   - Confirmed against Epigraph:
     - `PagePlugin` is a capability variant, not a reason to change the shared reader contract

5. `Manifest builder`
   - URL: `https://raw.githubusercontent.com/LNReader/lnreader-plugins/master/scripts/build-plugin-manifest.js`
   - Used for:
     - published plugin catalog entry shape
     - artifact URL expectations
     - `iconUrl`, `customJS`, `customCSS` fields
   - Confirmed against Epigraph:
     - Phase 1 and Phase 2 should consume the published catalog directly
     - no Epigraph-specific manifest shim is needed unless a compatibility defect is proven

### Tauri capability / sandbox / host isolation

1. `Capabilities`
   - URL: `https://v2.tauri.app/security/capabilities/`
   - Used for:
     - per-window and per-webview permission isolation
     - minimal permission strategy for the hidden plugin runtime host
   - Confirmed against Epigraph:
     - the main-window capability lives in [default.json](../src-tauri/capabilities/default.json)
     - the plugin runtime host must not reuse the broad default capability

2. `Runtime Authority`
   - URL: `https://v2.tauri.app/security/runtime-authority/`
   - Used for:
     - command exposure model
     - deny-by-default IPC posture for isolated windows/webviews
   - Confirmed against Epigraph:
     - the hidden host must expose only whitelisted domain actions

3. `Security Lifecycle`
   - URL: `https://v2.tauri.app/security/lifecycle/`
   - Used for:
     - lifecycle and threat-model framing for embedded runtime surfaces
   - Confirmed against Epigraph:
     - hidden does not mean trusted; capability isolation is mandatory

4. `Command Scopes`
   - URL: `https://v2.tauri.app/security/scope/`
   - Used for:
     - scoping plugin/window access to narrow actions
   - Confirmed against Epigraph:
     - the plugin host bridge must be strictly whitelisted

5. `Current Epigraph default capability`
   - File: [default.json](../src-tauri/capabilities/default.json)
   - Used for:
     - baseline comparison against the future novels runtime host capability
   - Confirmed against Epigraph:
     - current `main` window capability is intentionally broad
     - the hidden novels host must not inherit it wholesale

### Divergence handling rule

If the LNReader documentation and a real published plugin disagree:

1. record the plugin and the discrepancy in this document
2. record the audit date and reproduction evidence
3. freeze which truth Epigraph follows for the current phase
4. keep any Epigraph compatibility shim internal only

## Frozen truths

- Epigraph must use the LNReader repository and plugin ecosystem directly.
- Epigraph must not invent a proprietary novels plugin format.
- The exact plugin method contract must be confirmed from the audited LNReader sources before implementation freezes method names in code.
- If Epigraph wants an internal helper such as `fetchNovelDetailAndChapters`, it remains an internal wrapper over the confirmed LNReader contract.
- The plugin runtime and the reader surface are separate concerns.
- EPUB and plugin-based novel text can share reflow reader preferences at the UX contract layer.
- PDF keeps its own rendering adapter and does not pretend to be a reflow text reader.
- Novels are profile-scoped.
- Books remain global.
- sync identity is not the same as profile identity.
- No chapter content is synchronized in sync v1.

## Epigraph integration boundaries

### Reader shell boundary

The shared reader shell grows from:
- [ReaderHud.svelte](../src/components/reader/ReaderHud.svelte)
- [BookReader.svelte](../src/components/reader/BookReader.svelte)

This shell owns:
- chrome
- settings drawer
- immersive mode
- progress surface
- chapter or section navigation shell
- bookmarks and history shell

It does not own:
- plugin execution
- EPUB parsing internals
- PDF rendering internals

### Plugin runtime boundary

The novels plugin runtime owns:
- repository-aware plugin loading
- plugin settings
- filters
- source browsing
- chapter HTML or text fetch

It does not own:
- reader chrome
- sync mutation rules
- global app settings

### Adapter boundary

Adapters translate format-specific content into the shared reader shell.

- `NovelHtmlAdapter`
- `EpubAdapter`
- `PdfAdapter`

No adapter is allowed to force another format through its parser pipeline.

### Sync boundary

syncd rules are already frozen in Epigraph:
- books -> `books:global`
- novels -> `novels:profile:<id>`

Novels sync:
- library entries
- progress
- bookmarks
- history
- repository/plugin snapshot metadata

Novels do not sync:
- raw chapter content
- plugin binaries
- cookies
- tokens
- credentials
- arbitrary plugin web storage

## Host decision

The initial runtime host is a hidden `WebViewWindow`, but that is a reversible host implementation choice, not a domain truth.

The domain boundary is:
- `start()`
- `stop()`
- `invoke(action, payload)`
- `cancel(requestId)`
- `health()`

Any later host replacement must preserve this boundary.

## Host sandbox rule

The hidden plugin runtime host must be isolated by capability and IPC whitelist.

The host:
- must not inherit broad main-window permissions
- must only expose explicitly whitelisted actions
- must deny unknown actions by default

Hidden UI status alone is not a sandbox.

## Repository compatibility target

The implemented repository boundary supports:
- adding repository URLs
- removing repository URLs
- refreshing repositories
- caching plugin catalog metadata
- tracking available, installed, disabled, and update-available state

This must be implemented against the LNReader-published repository format rather than a new Epigraph format.

## Non-goals

- no proprietary novels plugin format
- no plugin-to-EPUB conversion pipeline
- no PDF-to-text fallback to fake parity
- no sync of chapter HTML/content in v1
- no trust bypass for recommended repos/plugins
- no manga runtime refactor beyond shared shell integration points

## Mobile/Core boundary

The Android client is a separate native Epigraph Mobile workspace built on Hayai. It consumes the same
novel scopes and sanitized repository/plugin metadata through Epigraph Core; it
does not receive chapter content or credentials during synchronization. The
Suwayomi GraphQL proxy is reserved for comics and must not be used to merge
LNReader profile data into the comics domain.
