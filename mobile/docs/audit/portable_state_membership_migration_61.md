# Migration 61: state memberships stop making library works

## Cause

After pairing, a device applies `comic.history`, `comic.chapter_state` and novel progress for works it
only knows from that state, such as titles the user migrated away from. Each one got a portable binding
and a manifest membership stamped with the record's `serverVersion`, so hydration could bind it for
History. Hydration then set `favorite = 1` on every bound work, the library repair published those
rows as `comic.entry inLibrary:true`, and the Core added them to Suwayomi. On the dev desktop this added
about 200 old titles next to the ones they had been migrated to (695 to 895 works).

A state record also moved a library work's stamp back to its `serverVersion`, so a manifest walk that
was running when it arrived could drop that work as stale.

## What changes

- State records join with `insertPortableStateMembership` at `observed_at = 0` and never overwrite an
  existing stamp.
- Hydration favorites a bound work only when a manifest walk listed it (`observed_at > 0`).
- `countPortableManifestMembershipsForEcosystem` counts library memberships only, so new history no
  longer forces a full walk.
- The migration turns older counter stamps (below 10^12, which no epoch-millisecond stamp reaches)
  into `0`. A library work that a state record had moved back drops out of the library count, so the
  next comic sync walks the manifest again and stamps it before hydration runs.

Rows already favorited by the old behavior, and titles the Core already imported, are left as they are.
Removing them is a user decision.

## Verification

`61.db` is the pre-migration fixture. `verifySqlDelightMigration`, `PortableStateMembershipMigration61Test`
and `SqlDelightPortableHydrationStoreTest` cover the upgrade, a repeated run, state-only hydration and
the stale cleanup.

## Rollback

An older build reads the rows unchanged. It treats `0` stamps as stale at its next manifest walk and
drops them, which only delays binding history-only works. A manual downgrade needs only
`PRAGMA user_version = 61`.
