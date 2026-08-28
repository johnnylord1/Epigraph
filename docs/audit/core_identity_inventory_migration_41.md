# Core identity and extension inventory migration 41

Migration `41.sqm` upgrades schema 41 to 42. It adds side tables only:

- `aethon_core_remote_identity` binds an existing local `entity_id` to a versioned Core identity;
- `aethon_core_extension_inventory_cache` durably stores the latest schema-versioned extension report and acknowledgement state.

No manga, chapter, category, tracker, download, outbox or local publication row is rewritten. Existing local IDs remain authoritative. Legacy records are not guessed or backfilled; integration code must explicitly write `LEGACY_UNBOUND`, `PENDING`, `BOUND` or `CONFLICT` after it has evidence.

The former SharedPreferences report is non-authoritative UI cache and is left untouched. It is not imported because it has no durable schema identity; the next authenticated inventory sync repopulates the SQLDelight cache. No extension installation state is lost because that state remains owned by Android's package manager and the extension manager.

## Runtime validation (2026-08-09)

The migration and Core-bound source were exercised with the real desktop
profile and an updated development APK. The sync worker completed successfully
and materialized a catalog larger than 600 entries without replacing local
IDs. Suwayomi's reserved category `id = 0` is accepted as protocol input but is
not materialized as a user folder.

Authenticated covers, details, chapters and pages were validated through the
Core. The later unpaired-retention correction supersedes the original
`initialized = false` behavior: complete catalog summaries are now inserted as
last-known-good metadata with `initialized = true`. Opening a title while
unpaired therefore renders its persisted metadata and existing local chapters
without first requiring Core credentials. While paired, explicit refreshes and
missing chapter data still use the authenticated Core source. An Asura Scans
title loaded 25 chapters and a real reader page. A separate source which no
longer provides pages returned the same upstream error through direct Suwayomi
GraphQL, so it was not classified as a mobile or Core regression.

Focused HTTP, internal-source, catalog and projection tests pass, and the
`devDebug` APK builds and installs. Later smokes closed bidirectional progress,
category mutation and offline download/read. Remaining release gates are a
real inventory-change reconciliation in the UI, physical-device coverage and
Windows-restart recovery of the default Core port.

Reader progress has since been validated bidirectionally on the same real
profile. A server-scoped comic identity emitted an official
`UpdateChaptersProgress` command for chapter `1057`; Suwayomi confirmed
`lastPageRead` advancing from `0` to `3` and then `5`. The parser retains the
Legacy profile-scoped identity for compatibility and does not bind ambiguous
records.

Rapid page updates are coalesced before waking WorkManager, while the domain
write and both outboxes remain committed atomically. Outbox-only wakes no
longer run the full catalog replica. A focused unit test proves one trailing
wake for a burst, the reader routing tests cover current and Legacy identity
forms, and the real smoke observed one work ID rather than one job per page.
Category mutation was also exercised through the real detail UI. Adding the
title to `Lendo` produced the expected two-category upstream state, and
removing it restored the original `Dropado` assignment. The remaining gates
are extension reconciliation UI, physical-device coverage and Windows restart
recovery of port 4777.

The real inventory hash did not change, so the user prompt correctly did not
reappear. The non-exported reconciliation Activity was not weakened or made
shell-launchable for testing. Its parity states and sequential visible
installer queue remain covered deterministically; first-change visual
evidence is still pending.

The offline gate was subsequently completed without a synthetic database row.
Chapter `1057` was downloaded from the detail flow, producing a 15,819,146-byte
CBZ, and reopened after the emulator proxy was removed. Seven source pages
were rendered as eleven local images because tall pages were split by the
existing downloader preference. Archive entries now retain both the local
display index and the original source-page index. Reader persistence keeps the
display index for local resume but sends only the source index to Core. A
source-count checkpoint maps an online position to the first matching split
segment on the initial offline open; later offline positions are not remapped.
Nonstandard archives retain the previous fallback behavior.

Focused tests cover split-name parsing, online-to-offline restoration,
already-offline restoration and distinct local/remote progress values. The
final `devDebug` APK builds and installs successfully.

## Unpaired retention correction (2026-08-10)

Inspection of the real emulator profile found 631 favorite Core comics, 631
Core bindings, four categories, one cached extension inventory and three local
books. All 631 comic rows were persisted, but all had `initialized = false` and
their covers were still authenticated legacy Core references. This made
the catalog look present while details and uncached covers still depended on an
active pairing.

Migration `44.sqm` upgrades only rows owned by the reserved Epigraph Core source
to `initialized = true`. The catalog sync now also materializes a bounded,
sequential batch of confirmed covers into the normal library cover cache while
credentials are available. Disconnect still deletes only the credential; it
does not remove manga rows, categories, extension inventory, progress,
downloads or cached covers.

The supported unpaired behavior is intentionally precise:

- Library metadata, categories, progress, extension inventory and cached
  covers remain available locally;
- existing chapter rows and explicitly downloaded chapters remain readable;
- EPUB/PDF files already stored locally remain readable;
- uncached covers and chapter/page data never downloaded to the device still
  require a new authenticated pairing.

The cover backfill is bounded to 32 missing covers per successful catalog sync
to avoid a 600-title network and memory spike. It is eventual while paired,
not an assertion that every remote asset is instantly available offline.

## Rollback

There is no automatic downgrade. Older builds ignore the added tables. If a manual database downgrade is required, first export a normal backup and preserve any extension reconciliation report needed for diagnostics. Then drop `aethon_core_extension_inventory_cache` and `aethon_core_remote_identity` before lowering the SQLite user version. Dropping these side tables removes only Core bindings and cached reports; it must never rewrite or delete local manga IDs or content rows.
