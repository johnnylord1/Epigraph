# Device sync selection and scoped pairing

## Contract

The mobile policy is keyed by `serverId + profileId + deviceId` and is stored
outside the encrypted credential. It controls execution, not ownership of
synchronized data. Disconnecting removes the credential but does not remove the
materialized Library, covers, categories, chapters, progress, bookmarks,
highlights, downloads, local books, assets or pending outbox commands.

The effective policy is the intersection of:

```text
local device selection
AND scopes currently granted by the paired Core
AND capabilities currently advertised by that Core
```

Supported domains are Comics, Novels and Books. EPUB/PDF assets remain
on-demand. Dependency reconciliation is inventory-only until the user chooses
an explicit action.

## Pairing flow

```text
validate bundle
-> inspect bootstrap identity
-> select domains and dependency inventories
-> claim requested scopes
-> wait for desktop approval
-> persist credential and selection
-> enqueue initial sync
```

The wizard cannot continue with zero domains. Existing sessions receive the
recommended Legacy-compatible policy without losing their current data. If a
locally selected domain is not granted, Settings reports that desktop approval
is required instead of retrying indefinitely.

## Pipeline behavior

- Books providers and assets run only when Books is effective.
- Novel replica and LNReader inventories run only when Novels is effective.
- Suwayomi catalog and comic-extension inventory run only when Comics is
  effective.
- Comic repository refresh is an independent local policy. Disabling it keeps
  installed-extension parity available but does not refresh or consult the
  Android repository catalog; it never imports Suwayomi Extension Store URLs.
- The outbox claims only active scopes. Paused rows remain durable, are not
  counted as active failures and resume when the policy is enabled again.
- Fresh scopes returned by `/v1/session` are used in the same sync pass, so a
  desktop revocation takes effect without waiting for credential persistence.

## Dependency authorities

```text
Comics: Suwayomi inventory -> optional trusted Android repository refresh -> private installer after "Install all"
Novels: Core descriptors -> user-approved LNReader repository -> NovelPluginManager
Books: no extension runtime
```

Sync never transfers executable APK, JAR or JavaScript artifacts. Inventory
comparison never installs or enables a dependency automatically. A missing
dependency does not block catalog synchronization or remove offline data.

## Offline semantics

Offline includes a device with no active pairing. Materialized metadata and
cached covers remain available. Previously downloaded comic chapters and
EPUB/PDF files remain readable. Content bytes, covers or chapters that were
never materialized still require a compatible pairing or their original local
source; the UI must not present those missing bytes as corruption.

## Verification

- SQLDelight migrations 45-46 and upgrade fixtures preserve content tables.
- Pairing tests cover requested scopes and partial persistence failure.
- Policy tests cover server-grant revocation and independent comic repository,
  comic extension and LNReader inventory flags.
- Worker tests cover active-scope filtering and paused queues.
- Comic extension installation remains explicit and sequential.
- LNReader repository approval and plugin installation remain explicit actions.
- The real Settings editor renders independent `Compare comics repositories`
  and `Compare comics extensions` controls without clipping.
- A real Core-connected sync completed with `SUCCESS` after resolving the
  interface bindings used by the LNReader replica.
- The connected sync materialized 21 comic covers. After using `Forget
  connection on this device`, the catalog, categories and those covers remained
  visible, including after a full mobile process restart.

The remaining real-device gate is a fresh pairing through the wizard followed
by a genuine inventory change. The gate must not create fake user data or
silently install dependencies.
