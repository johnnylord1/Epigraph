# SQLDelight and backup audit

## Current model

```text
mangas
 |- chapters -- history
 |- mangas_categories -- categories
 |- manga_sync (third-party trackers, not device sync)
 `- custom_manga_info

extension_repos
novel_repos
saved_search
novel_stats and other enrichment/search tables
```

The selected baseline has migrations 1 through 35 and adds novel repositories/stats, but novels still reuse `mangas` and `chapters`. Epigraph migration 36 normalizes legacy category ordering, and migration 37 adds isolated side tables for stable identities, category scope, sync state, immutable assets, and paired Core metadata without replacing any existing local ID.

## Migration gate status

The legacy parser failure in migration 1 was repaired by using SQLite's lowercase `replace` function, and migration 9 now creates `categories.manga_order` as `NOT NULL`. Migration 36 normalizes databases that already contain a nullable value.

Schema fixtures `36.db`, `37.db`, and `38.db` are retained beside the migrations. On 2026-07-22, both `generateCommonMainDatabaseSchema` and `verifySqlDelightMigration --rerun-tasks` completed successfully on Windows. Migration 37 therefore has a verified 37-to-38 upgrade fixture.

Linux CI remains a release gate so that the SQLite JDBC and SQLDelight path is exercised on a second operating system.

Migrations 17/18 rebuild tables and still need explicit `foreign_key_check` and `integrity_check` fixtures in the CI hardening phase.

## Epigraph schema 38

Migration 37 adds:

- `aethon_content_identity` and `aethon_source_binding` for stable cross-device identity while preserving local IDs;
- category identities/scopes for `ALL`, `MANGA`, `NOVEL`, and `BOOK` categories;
- chapter bindings and portable reader progress records;
- sequence-ordered outbox, leases, receipts, inbox ledger, checkpoints, revisioned tombstones, and aliases for idempotent replication;
- `aethon_asset_manifest` plus work/asset bindings for SHA-256-addressed EPUB, PDF, and downloaded novel chapter assets;
- non-secret paired-Core metadata containing endpoint, pinned certificate fingerprint, capabilities, and the single active-Core flag only.

`EpigraphMutationCoordinator` is now the required transaction boundary. It wraps each local domain change and one or more ordered outbox inserts in one `DatabaseHandler.await(inTransaction = true)` call. `mutateLocalBatch` computes the domain diff and envelopes inside that transaction. Remote apply writes the domain change, inbox receipt, and checkpoint atomically without echoing to the outbox; ACK writes its receipt and removes the matching device/mutation pair atomically. Local and remote reader-progress writes are separate: a local write preserves the last Core revision, while a stale remote event cannot overwrite it. Twelve host tests cover coordinator commit/rollback, ordered batches, two-device idempotency, leases, replay/ACK/progress and the first real library/category mutation router, including no-op/no-echo behavior.

### Rollback note

Before a production build upgrades a user database to schema 38, create a normal Epigraph backup. Code rollback is safe only while the older binary ignores unknown tables. If an explicit database downgrade is ever required, export pending outbox records first, drop every `epigraph_*` table and index introduced by migration 37, then set the schema version back to 37 in one maintenance transaction. Never perform that downgrade automatically: dropping the tables discards unsynchronized Epigraph state.

## Backup risks

- Restore is neither all-or-nothing nor resumable.
- History matching can use chapter URL without sufficient source/work identity.
- Automatic backups are finalized through a verified `.part` rename; a manual backup goes to a
  user-chosen SAF document, which is validated in place and deleted on failure.
- The backup file and its decompressed payload are limited to 256 MiB.
- Credentials (`__PRIVATE_` keys and credential-named keys) are excluded on create and ignored on
  restore; the old "include sensitive settings" option is gone.
- EPUB/PDF bytes, extension/plugin dependencies, and Epigraph identities are not represented.

## Implemented side tables

```text
aethon_content_identity
aethon_source_binding
aethon_category_scope
aethon_category_identity
aethon_chapter_binding
aethon_reader_progress
aethon_sync_outbox
aethon_sync_receipt
aethon_sync_checkpoint
aethon_sync_inbox
aethon_sync_tombstone
aethon_asset_manifest
aethon_entity_asset
aethon_paired_core
aethon_entity_alias
```

Device tokens remain intentionally absent and must live in Android secure storage. The schema assumes one active Core in v1; pairing code must deactivate the previous Core in the same transaction before activating another. `EpigraphLibraryMutationRouter` now applies favorite/category diffs with throwing SQL writes and ordered outbox commands, but it is not connected to UI/DI yet and other mutation families remain. Existing repository methods that catch exceptions and return `false` cannot be used as the atomic write primitive.
