# Tracker sync contract (Phase 3)

Status: implemented on both sides. Until a Core advertises the capabilities below, the mobile
keeps every tracker change local, so shipping the mobile first is safe.

Tracker sync has two parts, and they are gated separately:

| Part | What travels | Where | Gate |
| --- | --- | --- | --- |
| Tracking records | Tracker bindings from `manga_sync` (no secrets) | Normal outbox, snapshots, `/v1/changes` | `snapshotEntityTypes` contains `comic.tracking` / `novel.tracking` |
| Tracker credentials | Logins (username, password, token) | Only `/v1/tracker-credentials` on the paired TLS session | `supportsTrackerCredentialsV1 = true` |

## 1. Tracking records (`comic.tracking`, `novel.tracking`)

### Identity

`entityId = "<entityType>::<workId>::<trackerKey>"`

- `comic.tracking` needs a BOUND portable work binding, so `workId` starts with `comic:`.
  Comics without one stay local.
- `novel.tracking` uses the portable work binding when one exists, and otherwise the novel's
  Epigraph identity (`novel:...`).
- `trackerKey` is a stable wire key. The local numeric `manga_sync.sync_id` never leaves the
  device.

| trackerKey | local sync_id | credentials sync |
| --- | --- | --- |
| `myanimelist` | 1 | yes |
| `anilist` | 2 | yes |
| `kitsu` | 3 | yes |
| `shikimori` | 4 | yes |
| `bangumi` | 5 | yes |
| `komga` | 6 | no (enhanced, device-local source) |
| `mangaupdates` | 7 | yes |
| `kavita` | 8 | no (enhanced) |
| `suwayomi` | 9 | no (enhanced) |
| `novelupdates` | 10 | yes |
| `novellist` | 11 | yes |
| `hardcover` | 12 | yes |

Unknown tracker keys must be preserved by the Core and ignored by clients that do not know them.

### Mutation (outbox, `MERGE`)

The mobile always sends the **full state** of the binding. The Core must store the record as a
whole and resolve concurrent writers with its normal record-level LWW, using the causal/Lamport
order it already applies to other entity types. It must not merge individual fields.

```json
{
  "trackingId": "comic.tracking::comic:v3:...::anilist",
  "comicId": "comic:v3:...",          // "novelId" for novel.tracking
  "trackerKey": "anilist",
  "remoteId": 4242,
  "libraryId": null,                   // number or null
  "title": "Title on the tracker",
  "remoteUrl": "https://anilist.co/manga/4242",
  "status": 1,                         // tracker-specific status code
  "progress": 12.5,                    // finite double
  "totalChapters": 100,
  "score": 8.0,                        // finite double, tracker-specific scale
  "startedAtMs": 0,                    // 0 = unknown
  "finishedAtMs": 0,
  "updatedAtMs": 1790000000000
}
```

To unbind a tracker, the mobile sends `DELETE` for the same `entityId`, and the Core stores a tombstone.

### Replica (snapshot and changes)

- Records with this shape are applied to `manga_sync` idempotently (`INSERT OR REPLACE`).
- Tombstones delete the row.
- Records are skipped, without failing the batch, when:
  - the work is not present locally;
  - the tracker key is unknown;
  - a field is missing or malformed.
- Unknown extra fields are ignored.
- Replica writes do not generate outbox commands, so there is no echo.

### Core requirements (tracking records)

1. Add `comic.tracking` and `novel.tracking` to `snapshotEntityTypes`, but only once all of the
   following are in place:
   - validation;
   - storage;
   - snapshot;
   - changes feed.
2. Validate the patch:
   - `entityId` must equal `trackingId`;
   - the `entityId` prefix must match the entity type;
   - the `comicId`/`novelId` must match the ID segment;
   - `trackerKey` must match `^[a-z][a-z0-9_]{0,63}$`;
   - the numeric fields must be finite.
3. Reject a patch that carries credential-looking fields (`token`, `password`, `accessToken`,
   `refreshToken`, `cookie`) with 400.
4. Scope: comic tracking goes in the comics scope and novel tracking in the novels scope, the
   same as library membership.

## 2. Tracker credentials (`tracker.credential`, capability `supportsTrackerCredentialsV1`)

The user explicitly authorized syncing tracker logins, with these constraints:

- Credentials travel **only** over the paired, certificate-pinned TLS session. The request carries
  the device's bearer token, and the endpoint is not public.
- They are never part of snapshots, `/v1/changes`, SSE events, logs, crash reports, or backups.
- On the mobile they are sealed in the Android Keystore:
  - alias `epigraph.syncd.tracker.credentials.v1`, AES-GCM;
  - AAD `app.epigraph.mobile/aethon-syncd/tracker-credentials/v1`;
  - file `noBackupFilesDir/aethon-sync/tracker-credentials-v1.bin`.
- The active logins stay in the tracker's private preferences, which are excluded from backup.
- They are wiped on unpair (see *Unpair*).

### Endpoints (Core)

All of these require `Authorization: Bearer <device token>` from a paired device. Values are
limited to 8 KiB each (UTF-8).

`GET /v1/tracker-credentials`

```json
{
  "schemaVersion": 1,
  "credentials": [
    { "trackerKey": "anilist", "revision": 3, "deleted": false,
      "username": "", "password": "", "token": "<opaque>", "updatedAtMs": 1790000000000 }
  ]
}
```

`PUT /v1/tracker-credentials/{trackerKey}`: compare-and-set.

```json
{ "baseRevision": 2, "deviceId": "<device id>", "username": "", "password": "", "token": "<opaque>" }
```

- `200`: returns the stored credential with `revision = baseRevision + 1`.
- `409`: `baseRevision` is not the current revision; nothing is written.
- `400`: the key or a value is invalid or too large.

`DELETE /v1/tracker-credentials/{trackerKey}`: compare-and-set logout. The body is
`{ "baseRevision": 3, "deviceId": "<device id>" }`.

- `200`: returns the tombstone `{ "trackerKey": "...", "revision": 4, "deleted": true }`.
- `409`: stale `baseRevision`.

### Core requirements (credentials)

1. Revisions are per `trackerKey`, start at 1, and increase monotonically. A tombstone keeps
   its revision, so every device converges on the logout.
2. Encrypt credentials at rest with a machine-bound key (DPAPI on Windows). Never write them to:
   - the replica database or snapshots;
   - diagnostic bundles or logs.
3. Advertise `supportsTrackerCredentialsV1: true` in `/v1/capabilities` only when all three
   endpoints work.
4. When a device is revoked, its token stops working, so it can no longer read credentials.
   Revocation does not delete the stored credentials; the remaining devices keep them.
5. Record `deviceId` for audit only. Do not echo it back to other devices.

### Desktop Suwayomi bridge (implemented in syncd)

The desktop logs its own Suwayomi in and out from the vault, and publishes the logins made in
Suwayomi back to the vault, for every tracker both apps share: MAL (1), AniList (2), Kitsu (3),
Shikimori (4), Bangumi (5) and MangaUpdates (7). Both apps store the same raw values (username,
password, token JSON with the same field names), so the Core only moves them; it never parses or
refreshes a token.

- **AniList:** replayed through Suwayomi's OAuth mutation, so Suwayomi also fetches the score
  format. No restart.
- **The others:** written to Suwayomi's `settings/tracker.xml`. Suwayomi reads that file only at
  startup, so the Core stops the Suwayomi it started, writes the file and starts it again (under
  the spawn gate and the maintenance lease). The expired flag is cleared on every write.
- **Desktop → vault:** each mirror tick compares `tracker.xml` with the vault and publishes only
  differences. A login pending from another device wins; a tombstone that never reached the
  desktop does not log the desktop out.
- **Known cost:** a token refresh on either side (Shikimori refreshes daily) is a new revision, so
  the other side may restart Suwayomi once to pick it up.

### Mobile algorithm (one run per negotiated sync session)

The mobile keeps, per tracker, the last *agreed* `(revision, value)` in the Keystore vault.

1. `GET` the list. If that fails, stop; the run changes nothing.
2. For each portable tracker:
   - **Core changed** (its revision differs from the agreed one): the Core wins.
     - The mobile applies the Core value, which is a login or, for a tombstone, a logout.
     - It stores the new agreement.
     - If the local value had changed too, the run counts a conflict.
   - **Only the local value changed**: the mobile sends `PUT` (login) or `DELETE` (logout) with
     the agreed revision as `baseRevision` (0 when there is none).
     - On `200` it stores the new agreement.
     - On `409` it does nothing; the next run reads the newer Core value.
3. A corrupted vault, or an invalidated Keystore key, loses only the agreements. The Core value
   then wins, the same as on a first pairing.

### Unpair

On unpair, and also before a *new* pairing is activated:

- the cached capabilities are deleted;
- every tracker whose current login **came from the Core** and was not changed afterwards is
  logged out;
- logins the user entered on this device stay;
- the vault is deleted.

When the user forgets the desktop, the device first calls `DELETE /v1/session` (Core advertises
`supportsSessionEndV1`) so the Core revokes its tokens and drops it from its devices list. The
call is best effort with a short timeout: an unreachable or older Core never stops the device from
forgetting locally, and the desktop can still revoke it from its own list.

## 3. Rollout and rollback

- **DB:** no schema change. `manga_sync` is used as-is, so there is no migration to roll back.
- **Mobile capability cache:** `noBackupFilesDir/aethon-sync/tracker-capabilities-v1.json` holds
  no secrets. It is removed on unpair.
- **Rollback, Core:** stop advertising the capabilities. The mobile stops emitting tracking
  records and stops calling the credential endpoints; local tracker data is unaffected.
- **Rollback, mobile:** drop the `TrackRepositoryImpl` router argument in `DomainModule`, and the
  `negotiatedHooks`/`pairingEndedListeners` arguments in the sync module.
- **Not in v1:** trackers that were bound before the Core advertised tracking are not backfilled.
  They sync on their next local change, for example the next progress update. A backfill pass can
  be added later behind the same capability.
- **Not in v1:** there is no separate user toggle for credential sync. It follows the pairing and
  the Core capability, so a user-facing switch needs strings (i18n) and is left to the UI owners.
