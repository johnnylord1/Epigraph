# Decisions

## 2026-04-05 - Phase 4B Books stays local-EPUB only and separate from the comics pipeline

Decision:
- the first real Books implementation in Aethon Desktop is limited to local EPUB ingest and local shelf persistence

Why:
- Books already existed structurally in Library, but mixing EPUB ingest, webnovel adapters, and final reader work in one pass would make the phase too broad and too risky
- EPUB.js is a practical browser-side stack for a Tauri/Svelte proof path without dragging Suwayomi manga assumptions into Books

Implementation posture:
- keep Books records separate from manga/comics state
- import local `.epub` files only in this phase
- persist imported EPUB asset copies and extracted covers under the Aethon desktop data directory
- show Books in its own shelf UI
- keep the first open path intentionally minimal
- do not turn this phase into a generic ebook manager or a source-platform phase

## 2026-04-05 - Library continuity should preserve the underlying page instance while Series Detail is open

Decision:
- opening a manga from Library should no longer replace the entire Library route subtree
- `SeriesDetail` should render as an overlay layer above the current page so Library can keep its live DOM/state when the user returns

Why:
- remounting Library made exact scroll/context restoration fragile
- the library/detail transition behaves more like an in-place drill-down than a true route change
- preserving the underlying page instance is simpler and more reliable than rebuilding the library state after every detail close

Implementation posture:
- Layout keeps the current page mounted
- `SeriesDetail` renders in an absolute overlay layer while `store.activeManga` is set
- Library still keeps store-backed fallback state for render-window and return-target recovery

## 2026-04-05 - Library return should prefer exact scroll restoration and use card targeting only as fallback

Decision:
- when returning from a manga detail view, Library restoration should prefer the stored `scrollTop`
- card-centered restore remains a fallback only when an exact scroll offset is not available

Why:
- running `scrollTo(top)` and `scrollIntoView(card)` together creates conflicting restore behavior
- restoring the exact scroll position best preserves the user's original context

Implementation posture:
- store `libraryScrollTop`, `libraryVisibleCount`, and `libraryReturnToMangaId`
- restore the render window first
- run exact scroll restore first
- only fall back to card targeting when there is no usable saved scroll offset

## 2026-04-05 - Tracker OAuth input should accept the real callback URL or the raw token/code

Decision:
- tracker login should normalize user-pasted OAuth input instead of requiring one exact callback shape

Why:
- tracker providers do not all return the same parameter style
- some flows return `?code=...`, others `#access_token=...`, and users often paste the entire redirected URL

Implementation posture:
- accept full callback URLs, direct query/hash fragments, or raw credential values
- infer whether the tracker expects `code` or `access_token` from the tracker auth URL
- normalize the final payload before calling the tracker login mutation

## 2026-04-05 - Reader web view is an explicit fallback, not a replacement reader mode

Decision:
- the desktop reader may open the chapter's real web page in a dedicated web view window as an escape hatch

Why:
- some chapters/source pages can fail or degrade in the built-in reader
- giving the user a source-native fallback is safer than trapping them in a broken chapter state

Implementation posture:
- expose a dedicated reader web view toggle from the reader chrome
- close the auxiliary web view when the chapter changes or the reader exits
- keep the built-in reader as the primary path
- keep a plain browser-open fallback available when the embedded web view is not enough

## 2026-04-05 - The default local server target moves to `127.0.0.1:4667`

Decision:
- the app-local default server URL is now `http://127.0.0.1:4667`

Why:
- the current desktop local runtime is targeting a profile-local server on port `4667`
- persisting the old `localhost:4567` default would keep dragging upgraded clients toward the stale endpoint

Implementation posture:
- bump persisted store version
- explicitly reset `serverUrl` on upgrade so existing local state picks up the new default

## 2026-04-05 - Reconciliation-first restore is the v1 backup recovery path

Decision:
- Mihon/J2K source recovery in Aethon Desktop now follows a reconciliation-first restore path

Why:
- many Mihon-compatible backups contain orphaned historical source ids
- exact source-id validation alone leaves too much recovery value on the table
- restoring the raw backup first and trying to patch later is too ambiguous and harder to reason about safely

Locked v1 rules:
- parse only the fields needed for reconciliation
- keep parsing in TypeScript
- keep the overlay app-local
- keep inference bounded with strict limits, caching, and timeouts
- only auto-select remaps when confidence is clearly high
- ambiguous leftovers require explicit user choice or explicit skip
- the original backup is never mutated
- the only restore payload sent to Suwayomi is the client-generated reconciled payload
- v1 is read / reconcile / review / restore only
- v1 is not a generic backup editor
- v1 does not export reconciled backup files

Overlay decision:
- accepted mappings are stored in `%APPDATA%\\aethon\\backup-reconciliation-overlay.json`
- overlay entries are keyed by backup fingerprint plus source-inventory fingerprint
- the overlay is desktop-local and does not depend on Suwayomi schema/storage changes

Language derivation decision:
- backup source `lang` is only derived when the mapping is deterministic and unambiguous
- otherwise `lang = null`
- normalized source-name matching without lang is only allowed when no language ambiguity remains

Inference decision:
- representative manga sampling must prefer distinctive titles with richer metadata
- do not sample by first-in-cluster order
- auto-remap thresholds are intentionally strict to favor safe recovery over aggressive guessing

## 2026-04-05 - Reconciliation v1 is validated, but exact repo-backed mappings still depend on extension installation on clean targets

Decision:
- treat the current v1 reconciliation engine as validated for:
  - local Mihon/J2K parsing
  - exact reconciliation
  - bounded/cached inference
  - overlay persistence/reuse
  - client-side reconciled payload generation
  - real restore into a disposable Suwayomi instance

What the disposable restore proved:
- the reconciled payload path is real and accepted by Suwayomi
- the original backup remains unchanged
- overlay reuse works when fingerprints match
- ambiguous leftovers are not silently forced

What the disposable restore also proved:
- `repo-source-id` exact matches are not the same thing as live installed sources on a clean Suwayomi profile
- if the target server does not have the corresponding extensions installed, restored manga can land successfully with stable source ids while still reporting missing sources and exposing no linked `source` object in GraphQL

Decision for v1 semantics:
- keep `repo-source-id` exact matches as valid reconciliation results
- surface `requiresInstall` clearly in the UI and overlay
- do not claim that an exact repo-backed mapping guarantees an immediately linked/usable source on a clean restore target
- treat extension installation on the target server as a separate requirement for full post-restore source usability

Near-term follow-up posture:
- do not broaden v1 into a generic backup editor
- if we improve this next, the evidence-based follow-up is extension-aware restore hardening:
  - either require/install selected extensions before restore
  - or make the restore UI explicitly gate "fully usable restore" on extension availability

## Template
| Date | Decision | Rationale | Status |
| --- | --- | --- | --- |
| YYYY-MM-DD | Short decision | Why this choice was made | Active |

## Log
| Date | Decision | Rationale | Status |
| --- | --- | --- | --- |
| 2026-04-01 | Upstream base is Moku | Aethon starts from the existing Moku repository to preserve a working baseline. | Active |
| 2026-04-01 | Work will happen in small phases | Small milestones reduce risk and keep scope controlled. | Active |
| 2026-04-01 | No feature expansion in Phase 0 | Phase 0 is limited to repository setup and documentation scaffolding. | Active |
| 2026-04-01 | No code refactor before the documentation baseline exists | The team needs a shared foundation before changing stable systems. | Active |
| 2026-04-01 | Phase 1 rebrand is limited to low-risk display surfaces | Product naming can change in visible UI and metadata while risky identifiers, integrations, and behavior stay intact. | Active |
| 2026-04-01 | Phase 2 uses `npm exec pnpm` as the validated fallback desktop path | The current machine has `node` and `npm` but not global `pnpm`, and the fallback successfully installed dependencies and built the frontend without changing repo behavior. | Active |
| 2026-04-01 | Native desktop validation remains blocked by missing Windows toolchain prerequisites | WebView2 is installed in the current environment, but Rust via `rustup` and Visual Studio Build Tools with MSVC + Windows SDK are still required before `tauri dev` can be validated end-to-end. | Active |
| 2026-04-01 | Phase 3A prioritizes two audit-confirmed runtime fixes before broader onboarding work | The Settings overlay persistence and leftover native window title are both reproducible, low-risk defects that can be fixed without changing product behavior or expanding scope. | Active |
| 2026-04-01 | Phase 3B prioritizes safe technical identity cleanup before onboarding | Runtime identity still leaked `Moku` through the Rust binary name and Discord activity text, so the safest remaining identity surfaces were cleaned before broader onboarding or distribution work. | Active |
| 2026-04-02 | Phase 3C prioritizes only safe Discord and distribution identity cleanup before onboarding | The remaining low-risk leaks are descriptive packaging metadata, while Discord application identity, updater wiring, app ids, and data paths still depend on external ownership or higher-risk distribution changes. | Active |
| 2026-04-02 | Roadmap numbering was updated to separate cleanup subphases from macro product phases | Phase 3 had become ambiguous because `3A-3D` were active desktop cleanup steps while the old roadmap also reserved `Phase 3` for Android. The roadmap now preserves Phase 3D as deferred and promotes Phase 4 onboarding/setup UX as the next active product phase ahead of riskier identity/distribution work. | Active |
| 2026-04-02 | Phase 4A focuses on setup-state clarity before any automatic repo seeding | Fresh profiles currently feel broken even when the app and server are healthy, so the first onboarding step is to detect missing setup states and explain the next action clearly before introducing any repo auto-configuration. | Active |
| 2026-04-02 | Phase 4B adds explicit recommended and manual repo setup instead of silent auto-seeding | The first actionable onboarding step should reduce friction without mutating server configuration behind the user's back, so Aethon now offers a one-click recommended repo path plus a visible manual repo-manager path. | Active |
| 2026-04-02 | Phase 4C focuses on extension onboarding after repo setup | Once a repository exists, the next user confusion is the gap between `repo configured` and `content extension installed`, so this phase clarifies that distinction and points users toward installing a usable extension before deeper search/source polish. | Active |
| 2026-04-02 | Post-4C discovery points to source visibility clarity as the next evidence-based onboarding target | In the real desktop app, repositories are configured, content extensions are installed, and source browsing can load titles. The confirmed UX gap is that Search exposes fewer usable sources than installed extensions without clearly explaining that current content filters hide part of the installed set, so the next phase should clarify source visibility before any broader search redesign. | Active |
| 2026-04-02 | Phase 4D targets source visibility clarity instead of a generic search overhaul | The real-window audit confirmed that source browsing works and did not prove a keyword-search failure. The next safe improvement is to explain why installed content extensions can outnumber visible Search sources when current content and language visibility rules narrow the usable source set. | Active |
| 2026-04-02 | Search is now the single discovery hub | Search already had the strongest direct-search, source-browse, onboarding, and visibility guidance flows. Consolidating discovery there removes redundant first-level destinations while preserving working behavior through relocation instead of query or product rewrites. | Active |
| 2026-04-02 | Discover was absorbed into Search > Browse and Tags moved under Browse | The old Discover surface was a weaker sibling of Search, and tag discovery is exploratory browse behavior rather than a peer of direct keyword search. Repositioning both under Browse clarifies hierarchy without breaking the existing catalog and tag flows. | Active |
| 2026-04-02 | Extensions and Tracking were demoted from first-level navigation | Extensions/repositories belong next to source discovery, and tracking is a settings/integration concern. Moving them out of the rail reduces first-level redundancy while keeping both behaviors reachable in context. | Active |
| 2026-04-02 | Settings IA cleanup was prioritized before Android bootstrap | After navigation cleanup, Settings became the densest remaining UX bottleneck in the desktop app. Reorganizing it by user mental model improves findability without changing behavior or expanding platform scope. | Active |
| 2026-04-02 | `Folders` is relabeled to `Categories` in the UI | The feature organizes library groupings backed by Suwayomi categories, not filesystem folders. The new label matches what users are actually managing while preserving the existing internal identifiers for low-risk compatibility. | Active |
| 2026-04-02 | Settings navigation is grouped by user mental model instead of the old flat order | Daily-use app options, reading options, library organization, integrations, system controls, and advanced tools should not compete at the same visual level. Grouping improves scanability while preserving the existing setting panels and behavior. | Active |
| 2026-04-02 | Settings groups are first-level buttons and sub-options live inside the content pane | The grouped labels alone were still too flat in practice, but a second full-height settings column compressed the actual panels too much. Making `App`, `Reading`, `Library`, `Content & Integrations`, `System`, and `Advanced` the primary left-side actions while rendering sub-options as a compact in-content selector preserves hierarchy without crushing the real settings content. | Active |
| 2026-04-02 | Browse is the user-facing discovery destination and Catalog replaces Featured plus Tags | The discovery surface is primarily exploratory rather than direct search, so the first-level label now reflects browsing. The old `Featured` and `Tags` split created redundant visual discovery surfaces, so they were unified into `Catalog` using the existing tag-driven implementation as the structural base while preserving immediate card browsing through the old `All` catalog behavior. | Active |
| 2026-04-02 | Catalog uses left-side filter groups and only exposes feed options that are proven in this fork | The new Catalog should clarify discovery instead of implying backend capabilities that are not actually wired. `Feed / Type` now keeps `All` as the only active guaranteed option, while unsupported feeds remain visibly deferred, and `Genres / Tags` moved into the left filter rail so users are not asked to juggle duplicate chip systems across the same screen. | Active |
| 2026-04-02 | Catalog Feed / Type now exposes only `All` and `Latest` | Phase 4H audited the local discovery paths and confirmed real support for `POPULAR` and `LATEST` fan-out through the existing source-manga fetch flow, with `All` remaining the default catalog feed and `Latest` added as a real alternate feed. `Popular`, `Trending`, `New`, and `Completed` were removed from the visible UI because this fork does not prove distinct working behaviors for them without a broader rewrite, and Aethon should not ship fake or deferred feed controls. | Active |
| 2026-04-02 | Android work is removed from the stable desktop line until the spike proves full shell viability | The Android spike proved only partial viability: toolchain bootstrap, APK build, install, and Activity launch worked, but the emulator shell still did not load the app reliably enough to validate Home, Library, Browse, Sources, Reader, and Settings end-to-end. Continuing that work on `main` would risk the stable desktop line for an unresolved platform blocker. | Active |
| 2026-04-02 | `android-spike-blocked` and `C:/Users/jhow-/Documents/Projetos/ForkMoku/Aethon-android-spike` are the isolated continuation point for Android | The spike needed to be preserved exactly as it existed, including local WIP and generated Android artifacts, before restoring desktop stability. A dedicated branch plus linked worktree isolates the blocked Android investigation without discarding any local progress or contaminating the stable desktop branch. | Active |
| 2026-04-02 | `85059d5` is the authoritative rollback baseline for the desktop cleanup | `85059d5` was the confirmed clean checkpoint created immediately before Android bootstrap work began. Using that exact commit avoids guessing rollback scope and gives the desktop line a known-good pre-Android baseline. | Active |
| 2026-04-02 | Android work may return to `main` only after the isolated spike fully loads the shell and completes real navigation validation | The Android spike is only worth merging back once it can do more than build/install/launch partially. The minimum return criteria are: the app shell loads correctly on emulator or device, it connects to the intended Suwayomi server, and Home, Library, Browse, Sources, Reader, and Settings can all be validated in the real Android runtime. | Active |
## 2026-04-02 - Post-rollback desktop validation stays on desktop and prioritizes Home first-touch

After isolating the blocked Android spike into a separate branch/worktree, the next pass on `main` was a discovery-only validation run in the real Tauri desktop window. The goal was to confirm whether the restored desktop line still behaved like the intended post-4H product before choosing any new implementation work.

The restored desktop line is viable:
- `Home` opens correctly
- `Browse` still exposes `Search / Catalog / Sources`
- `Catalog` still loads real card results
- `Sources` still loads working sources and still exposes `Extensions & Repos`
- `Settings` still uses the grouped two-level navigation model

The strongest evidence-based desktop UX problem is now `Home`, not Browse architecture. On a low-activity profile, Home is technically correct but too weak as a first-touch surface: it opens to mostly empty sections (`Nothing here yet`, `No chapters to show`, zeroed stats) and does not give enough useful forward motion compared with the stronger Browse experience.

Two smaller follow-up issues were also confirmed, but they are not the next primary phase:
- `Browse > Sources` still shows the source-visibility explanation that should live in `Browse > Search`
- the visible catalog feed label is back to `All` on the restored baseline

Decision:
- do not resume Android work on `main`
- treat the next implementation phase as a desktop-only `Home first-touch / empty-state guidance` phase
- keep Browse/Catalog/Sources follow-up polish as later, smaller cleanup work unless a new audit proves otherwise

Strict non-goals for the next phase:
- no Android work
- no Suwayomi/backend changes
- no reader behavior changes
- no source-browse rewrite
- no broad visual redesign

## 2026-04-02 - Home first-touch stays lightweight and Browse visibility guidance belongs only in Search

The next desktop-only implementation pass stayed intentionally small. The goal was not to redesign Home or Browse, but to make the restored desktop line feel less passive for low-activity profiles and to clean up two confirmed Browse regressions.

Decision:
- Home should provide lightweight first-touch direction when there is little or no recent reading activity, instead of leaving the dashboard as a mostly empty passive surface
- the guidance should point users toward useful next actions that already exist in the product, especially `Browse > Catalog`, `Browse > Sources`, and `Library`
- the source-visibility explanation belongs only in `Browse > Search`, where the mismatch is being explained in direct search context
- the duplicate visibility note should not appear in `Browse > Sources`
- the default Catalog feed keeps the same behavior, but its user-facing label should be `Popular` rather than `All`

Implementation policy for this pass:
- session-scoped dismiss state is enough for the Search visibility card; no backend, storage, or schema work is needed
- Home guidance remains additive and lightweight rather than becoming a new onboarding system
- no Android work returns to `main`

Active follow-up posture:
- treat this as a low-risk desktop polish pass, not a product architecture change
- choose the next phase from fresh desktop evidence rather than automatically expanding scope

## 2026-04-05 - Backup and restore should be thin Aethon controls over Suwayomi, not a parallel client backup system

The current Suwayomi server used by Aethon already exposes native GraphQL operations for backup and restore:
- `createBackup`
- `validateBackup`
- `restoreBackup`
- `restoreStatus`

Decision:
- Aethon should expose backup and restore as thin desktop controls over those existing server operations
- Aethon must not invent its own backup format or maintain a second backup pipeline in client state
- export should create a server backup and save the resulting file locally
- import should validate the selected backup first, then restore it through Suwayomi and surface server-side progress/status

Implementation policy for this phase:
- place the controls in `Settings > System > Storage` because they operate on the current server/data environment
- keep export and import scoped to the current connected Suwayomi server
- use GraphQL multipart upload for restore/validate instead of adding backend rewrites
- keep the result honest: if Desktop and Mobile point to the same server, both clients reflect the restored state because the server is canonical

Non-goals:
- no custom Aethon backup format
- no reader changes
- no Suwayomi backend rewrite
- no desktop/mobile state unification layer

## 2026-04-05 - Backup validation should offer extension installs when the server can identify a real match

Once backup validation reports `missingSources`, Aethon should do more than list the names and leave the user stranded. The desktop client already knows how to fetch available extensions and install them through Suwayomi, so the restore flow should reuse that capability when it can do so honestly.

Decision:
- backup validation now attempts to match each missing source against real extensions exposed by the current server/repos
- install suggestions are only shown when Aethon finds a concrete extension candidate; it must not fabricate a match
- when no reliable match is found, the UI should point the user to `Browse > Sources > Extensions & Repos` instead of pretending the app can resolve the source automatically

Implementation policy:
- reuse the existing extension install mutation rather than adding a second install path
- use the configured extension repo indexes as the source-id mapping layer whenever possible, because those indexes expose `sources[].id` and `sources[].name` for each installable extension
- fall back to conservative source-name matching only when an exact source-id match is unavailable
- keep restore and extension installation loosely coupled: suggested installs help close the gap before restore, but they do not rewrite Suwayomi backup semantics

## 2026-04-05 - Restore readiness must distinguish `ready_now` from `requiresInstall`

The disposable restore validation proved that exact reconciliation alone is not enough to guarantee a usable restored library on a clean target server. A backup can reconcile cleanly against repo-backed source ids and still restore into a server where the required extensions are not installed yet. In that case the restore succeeds, but the restored manga still do not link to usable live sources.

Decision:
- Aethon Desktop now treats restore readiness as a first-class preflight concern
- every selected reconciliation result is classified as one of:
  - `ready_now`
  - `requires_install`
  - `unavailable`
  - `unresolved`
- final restore must not be presented as fully usable when selected mappings still require extension installation on the target server
- the reconciled restore architecture stays intact:
  - parse
  - reconcile
  - overlay
  - readiness gate
  - final restore

Implementation policy:
- `requiresInstall` is surfaced directly in the desktop restore UI, not hidden in warnings
- a clean target with missing extensions is gated until the user installs the missing pieces or explicitly follows the install-first path
- a prepared target with the required extensions already installed is allowed through the same reconciled restore path without special-case branching
- unresolved leftovers remain unresolved by design; readiness hardening must not silently force ambiguous mappings

Consequence:
- the restore flow is now honest about the difference between `source id is known` and `source is actually usable on this server right now`
- the next restore-related work can stay narrow: it does not need a new backup format or a generic backup editor

## 2026-04-05 - Profile-scoped local runtime safety is enforced by lock plus live-process ownership checks

The local corruption investigation confirmed that the real risk was not only duplicate desktop windows; it was multiple Aethon instances attempting to spawn Suwayomi/Java against the same `rootDir`. The current hardening added a profile-scoped `server.lock`, but the validation also showed that stale lock files can happen after abnormal termination.

Decision:
- the durable rule is `one profile -> one Java/Suwayomi process`
- `server.lock` remains part of the protection path and must not be weakened
- the app also treats `existing Java process already owns this profile` as authoritative safety evidence when the lock file is stale
- shutdown only kills the child spawned by the current instance; it must not broad-kill unrelated Java processes

Implementation policy:
- spawn decisions must log explicit reasons:
  - lock acquired
  - stale lock detected
  - lock denied
  - spawn skipped because another process already owns the profile
- stale/damaged database handling stays quarantine-safe; old data is not silently deleted
- desktop single-instance shell work is optional later, but it is secondary to the profile-level runtime rule

Current posture after validation:
- the single-spawn protection is effective and merge-safe for this phase
- a remaining follow-up is that `server.lock` metadata can stay stale and point to a dead Aethon PID while runtime safety is actually being enforced by the live-process ownership check
- that stale-lock metadata issue is a smaller auditability follow-up, not a reason to reopen the broad corruption fix
