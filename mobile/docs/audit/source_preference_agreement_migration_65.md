# Migration 65: comic extension settings follow the paired desktop

## Cause

A comic extension setting chosen on the phone, such as Mangakakalot's preferred mirror, never reached the
desktop. The desktop's copy of the extension kept its default mirror, which now redirects to a site it
cannot parse, so the same source worked on one device and failed on the other.

## What changes

- New Core entity type `comic.source_preference`, one full-state record per source and setting key:
  `{preferenceId, sourceId, key, valueType, value, updatedAtMs}`, with `valueType` `boolean`, `string` or
  `string_set`. The wire change is additive: older builds ignore the type, and the protocol version is
  unchanged. The command is `set_source_preference`; Android never sends a delete.
- Only settings an extension shows on its screen as a switch, list, multi-choice list or text field are
  compared, and only once the user stored a value. Keys naming a credential, session, account or cache
  (`fetchedMirrors`, timestamps, user agents and similar) and values that look like a secret are never sent.
  The rules and limits match the desktop (`src-tauri/src/syncd/source_preferences.rs`).
- Settings live in each extension's own shared preferences, outside SQLDelight, so the outbox cannot share
  a transaction with the edit. Instead, after each Core replica pass `EpigraphSourcePreferenceSync` compares
  each setting with the Core record and with `epigraph_source_preference_agreement`, which remembers the
  value both sides last agreed on and the Core version it came from. The outbox row and the agreement are
  written in one transaction.
  - A value moved from the agreement is sent (this also backfills settings chosen before pairing).
  - A newer Core version is written into the extension's preferences and recorded as agreed, so it is never
    sent back. On a first comparison with no agreement, the Core value wins.
  - A Core value the installed extension does not list (an older version) is left out until either side
    changes again.
- Closing an extension's settings screen after changing a setting asks for a background sync.
- The table is cleared with the rest of the Core replica on reset or unpair.

## Verification

`65.db` is the pre-migration fixture. `verifySqlDelightMigration`, `SourcePreferenceAgreementMigration65Test`,
`EpigraphSourcePreferenceSyncTest`, `SourcePreferenceRulesTest` and `CoreV1OutboxAdapterTest` cover the
upgrade, a repeated run, a fresh schema, the decision rules, echo suppression, secret keys and the Core
patch shape.

## Rollback

Older builds never read the table and ignore `comic.source_preference` records. To roll back the schema:

```sql
DROP TABLE IF EXISTS epigraph_source_preference_agreement;
PRAGMA user_version = 65;
```

Extension settings already applied from the desktop stay as they are; they are ordinary extension
preferences.

## Novel plugin settings (no new migration)

The same comparison now also covers the settings LNReader novel plugins declare in `pluginSettings`, such
as WTR-LAB's preferred translation, Komga's server address or BoxNovel's "hide locked chapters".

- New Core entity type `novel.plugin_setting` in the novels scope, one full-state record per plugin and
  key: `{settingId, pluginId, key, valueType, value, updatedAtMs}`. The command is
  `set_novel_plugin_setting`, sent as a merge; Android never sends a delete. The change is additive, like
  `comic.source_preference`, and the rules match the desktop (`src-tauri/src/syncd/novel_plugin_settings.rs`).
- Values, limits and the keys that never travel are those of `comic.source_preference`: WTR-LAB's
  `sessionCookie` and `signInUrl`, and Komga's `email` and `password`, stay on the device. A server
  address with credentials in it is not sent either.
- `EpigraphSourcePreferenceSync` runs a second time with `SourcePreferenceKind.NovelPlugin`, reading and
  writing the plugin's own storage through `AndroidNovelPluginSettingStore`. Writing reloads the plugin so
  the next request uses the value. A Select value the installed plugin does not list is not applied.
- Agreements share `epigraph_source_preference_agreement`. Entity IDs start with the entity type
  (`novel.plugin_setting::` against `comic.source_preference::`) and rows are keyed by scope, so the two
  kinds never collide and the table needs no new column or migration. Rolling back to a build without
  this kind leaves rows it never reads; the migration 65 rollback above removes them with the table.
- Closing a novel plugin's settings screen after a change asks for a background sync.
- Covered by `NovelPluginSettingRulesTest`, `EpigraphNovelPluginSettingSyncTest`,
  `AndroidNovelPluginSettingStoreTest`, `CoreV1OutboxAdapterTest` and `CoreTrackingCapabilityCacheTest`.
