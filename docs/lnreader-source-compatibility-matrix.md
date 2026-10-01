# LNReader Source Compatibility Matrix

Historical live observation date: `2026-04-12`

Documentation review date: `2026-07-28`

This matrix tracks real Epigraph runtime compatibility against official LNReader sources.

The rows below preserve the last live observations and must not be interpreted
as a current guarantee that an external website is available. Current blocking
gates validate the LNReader runtime deterministically; live source checks are
observational and update a row only when the complete action is reproduced.

Rules:

- multisrc remains build-time only in the upstream ecosystem
- Epigraph targets the final generated plugin artifact published in `plugins.min.json`
- this matrix records only what has actually been observed in Epigraph
- `working` means the source has been proven on the listed actions
- `migration-safe` means the source is proven on install, open, search, details, and chapter in the historical probes; like `working`, it can participate in novels migration
- `working-with-known-limitations` means the source works on the listed actions but still has a known quality issue
- `blocked-by-site` means the current blocker is external site behavior such as redirect, anti-bot, or rate limit
- `runtime-gap` means the blocker is in Epigraph's current runtime/helper boundary
- `pending` means the source has not been exercised enough yet

## English Priority

| Source | Install | Open | Search | Details | Chapter | Filters/Settings | Charset | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `archiveofourown` | observed | observed | proven | product-real | product-real | observed | acceptable | `migration-safe` | Current strongest English source in the product slice. Proven in `Browse > Sources > Novel Sources`, details, library add, reader open, and restart persistence, and now part of the minimum migration-safe cohort. |
| `inkitt` | observed | observed | supplemental | not yet proven | not yet proven | observed | mojibake observed | `working-with-known-limitations` | Live `searchNovels` returned structured results, but saved evidence still contains mojibake in one title. |
| `royalroad` | observed | observed | proven | proven | proven | observed | acceptable | `migration-safe` | Ad-hoc live probe now proves `search + details + chapter` against the official source boundary, completing the second English slot in the current migration-safe cohort. |
| `scribblehub` | pending | pending | pending | pending | pending | pending | pending | `pending` | Priority English cohort target. Live probes still need a real search seed that returns structured results. |
| `webnovel` | pending | pending | pending | pending | pending | pending | pending | `pending` | Priority English cohort target. Live probes still need a real search seed that returns structured results. |

## Portuguese Priority

| Source | Install | Open | Search | Details | Chapter | Filters/Settings | Charset | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `lanovels` | observed | observed | not yet proven | blocked in direct probe | blocked in direct probe | observed | unknown | `blocked-by-site` | Earlier live direct network probes returned redirect / anti-bot HTML instead of clean source payloads. |
| `illusia` | observed | observed | proven | proven | proven | observed | acceptable | `migration-safe` | Ad-hoc live probe now proves `search + details + chapter`. `fetchApi().text()` decoding was normalized in the runtime, and saved code points confirm the correct UTF-8 text. This closes the current pt-BR side of the minimum migration-safe cohort. |
| `lightnovelbrasil` | observed | observed | blocked in live probe | blocked in live probe | blocked in live probe | observed | unknown | `blocked-by-site` | The runtime wrapper gap is closed, but live search currently lands on a JS redirect / anti-bot challenge page instead of structured source HTML. |
| `betternovels` | observed | observed | blocked in live probe | blocked in live probe | blocked in live probe | observed | unknown | `blocked-by-site` | The repository manifest marks this source as down, and live probes currently fail with DNS / site reachability errors. |
| `centralnovel` | observed | observed | proven | proven | proven | observed | acceptable | `working` | Browse-seeded live probe proved search, details, and chapter for `86: Eighty Six`. This is now a solid runtime-working source, but not yet promoted into the migration-safe cohort. |
| `tsundoku` | pending | pending | pending | pending | pending | pending | pending | `pending` | Priority Portuguese cohort target. |

## Other Observed Sources

| Source | Search | Details | Chapter | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| `69shu` | not the focus | proven | proven | `working-with-known-limitations` | Trusted desktop smoke anchor for details + chapter. Useful for runtime boundary validation, but not a priority language cohort. |
| `hotnovelpub` | not yet proven | blocked in direct probe | blocked in direct probe | `blocked-by-site` | Direct live probe hit redirect / anti-bot HTML. |

## Future Live Revalidation Order

1. `scribblehub`
2. `webnovel`
3. `tsundoku`
4. `betternovels`

## Migration Gate

- a source can take part in novel migration (as origin or target) once its
  install smoke on the current profile proved plugin load, search, details and
  chapter, i.e. it is classified `working` or `migration-safe`
- that smoke already runs when a source is installed or updated, so migration
  adds no second, product-wide cohort gate and no fixed allow-list
- `working-with-known-limitations`, `blocked-by-site`, `runtime-gap` and
  `pending` sources stay out: their titles and chapter names would feed the
  matcher, or the site cannot be reached reliably
- before a profile's own smoke has run, the rows of this matrix are the fallback
- a smoke that ended `pending` (offline, site hiccup, runtime gap fixed by an
  update) is retried after 15 minutes the next time a novel screen asks, so one
  bad run does not keep a source out of migration for good
- when no installed source qualifies, the migration modals point the user to
  `Novel sources` instead of showing a dead end

## Evidence Anchors

- [pluginRuntime.test.ts](../src/lib/novels/pluginRuntime.test.ts):
  plugin execution, fetch shims, encoding, anti-bot recovery, and failure paths.
- [runtimeHost.test.ts](../src/lib/novels/runtimeHost.test.ts): isolated host,
  whitelist, invocation, cancellation, health, and shutdown.
- [repositories.test.ts](../src/lib/novels/repositories.test.ts): published
  repository parsing, canonicalization, and artifact metadata.
- [migrationSafe.test.ts](../src/lib/novels/migrationSafe.test.ts): migration
  eligibility from the install smoke classification.
- [offlineChapters.test.ts](../src/lib/novels/offlineChapters.test.ts): bounded
  offline chapter storage and fallback.

The JSON files from the original probes lived under disposable `tmp/`
directories and are intentionally not durable documentation.
