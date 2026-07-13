# Aethon Core comic reader-state contract

This additive protocol slice synchronizes state that Suwayomi does not expose
with sufficient page precision. Suwayomi remains authoritative for the comic
catalog, library membership, categories, chapters, and chapter read flags.
The Core is authoritative only for the two entities documented here.

## Capability and scope

Clients must discover support through `GET /v1/capabilities` and require both:

- `comics:profile:<paired-profile>` in `supportedScopes`;
- `comic.history` and `comic.page_bookmark` in `snapshotEntityTypes`.

This is additive to snapshot schema version 1. Older clients can continue to
use books and novels without requesting a comics snapshot. Every comics call
is authenticated and must use the exact profile of the bearer token:
`comics:profile:{tokenProfileId}`. A token for another profile is rejected even
if the requested scope is structurally valid.

## Shared identity and locator rules

`comicId` is the mobile `MediaKey` wire value:

```text
suwayomi:<normalized-server-fingerprint>:manga:<manga-id>
```

The server fingerprint is lowercase and contains only ASCII letters, digits,
period, underscore, or hyphen. A SHA-256 fingerprint is represented as 64
lowercase hexadecimal characters. `chapterId` is the stable Suwayomi chapter
identifier. `pageIndex` is zero-based. If `pageCount` is present it must be
positive and greater than `pageIndex`.

IDs and chapter identifiers are non-empty, NUL-free, and limited to 512 UTF-8
bytes. A bookmark label is optional and limited to 512 UTF-8 bytes. Timestamps
are non-negative Unix milliseconds. Unknown payload fields are rejected.
Credentials, cookies, upstream URLs with secrets, and WebView state must never
be placed in either payload.

## `comic.history`

There is exactly one Core history record per comic. `entityId` is deterministic:
`comic.history::<comicId>`. `patch.historyId` must exactly equal it. A merge has
this shape:

```json
{
  "entityType": "comic.history",
  "clientMutationId": "01J...",
  "scopeId": "comics:profile:main",
  "entityId": "comic.history::suwayomi:9d8f...:manga:123",
  "lamport": 42,
  "patch": {
    "historyId": "comic.history::suwayomi:9d8f...:manga:123",
    "comicId": "suwayomi:9d8f...:manga:123",
    "chapterId": "456",
    "pageIndex": 7,
    "pageCount": 24,
    "progressPercent": 0.3333333333,
    "readAtMs": 1783814400000
  }
}
```

`progressPercent` is inclusive in `[0, 1]`. The deterministic ID lets the mobile
client and invisible desktop bridge update the same record without prior ID
coordination. A record cannot be moved to another `comicId`. Chapter and page
may change as reading advances.

## `comic.page_bookmark`

`entityId` is the client-generated bookmark ID. `patch.bookmarkId` must exactly
equal it:

```json
{
  "entityType": "comic.page_bookmark",
  "clientMutationId": "01J...",
  "scopeId": "comics:profile:main",
  "entityId": "bookmark-01J...",
  "lamport": 43,
  "patch": {
    "bookmarkId": "bookmark-01J...",
    "comicId": "suwayomi:9d8f...:manga:123",
    "chapterId": "456",
    "pageIndex": 7,
    "pageCount": 24,
    "label": "Color spread",
    "savedAtMs": 1783814401000
  }
}
```

An existing bookmark cannot be moved to another `comicId`. Its chapter, page,
label, and timestamp may be edited by a later accepted command.

## Delete, replay, and convergence

Delete uses the same entity type, scope, and entity ID, sets `op` to `delete`,
and omits `patch`. A patch on delete is rejected. Deletes create retained
tombstones and are emitted by `/v1/changes` and `/v1/events`.

A merge at or below a tombstone's Lamport is rejected. An explicit later merge
with a strictly greater Lamport resurrects the same ID and removes the
tombstone. `deviceId + clientMutationId` receipts make exact retries idempotent;
reusing a client mutation ID for different content remains a conflict.

`GET /v1/snapshot?scopeId=comics:profile:<id>` returns the complete materialized
set of both entities plus tombstones in a consistent transaction. Clients must
replace only that scope's replica, preserve their local outbox, and never infer
deletion from a partial changes page. If replay has expired, fetch a snapshot.

The desktop bridge and Android client must publish the same `comicId`,
zero-based page index, stable entity ID, and Lamport rules. The bridge is a data
adapter only; no desktop visual component is required by this contract.
