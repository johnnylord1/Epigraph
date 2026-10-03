# One category identity per library (migration 54)

Migration `54.sqm` upgrades schema 54 to 55. It rebuilds
`aethon_category_identity` so that one phone folder can hold one identity per
library: `UNIQUE(local_category_id, content_scope)` replaces
`UNIQUE(local_category_id)`.

## Cause

A phone folder (`categories`) is shared by comics, novels and books. The
desktop keeps three separate category lists: Suwayomi categories for comics,
`novel.category` and `book.category`. With one identity per folder:

- The book and novel routers looked the folder up without a library, found the
  comic identity, and re-labelled it `BOOK` or `NOVEL`. Book assignments were
  then sent with a Suwayomi category id, and comic assignments stopped.
- A desktop category with the same name as an existing folder could not join
  it, so it arrived as a second folder with the same name.
- Re-pairing with another desktop deleted the folder of each old Suwayomi
  category the new desktop did not list, along with its comic assignments
  (audit item C14).

## What the migration touches

Every row of `aethon_category_identity` is copied. Its library is repaired
from the shape of its entity id, because that id says which desktop list the
category came from:

| Entity id | Library |
|---|---|
| `suwayomi:*:category:*` | `MANGA` |
| `novel-category-local-*` | `NOVEL` |
| `book-category-local-*` | `BOOK` |
| anything else | stored value kept |

Before the migration each folder had at most one row, so the repaired rows
cannot collide on the new key. No folder, assignment or outbox row changes.

`CategoryIdentityMigration54Test` covers the repair, several identities on one
folder, the rejected second identity of the same library, and the cascade on
folder delete. `55.db` is the schema fixture for the upgraded database.

## Behaviour that depends on it

- Routers look identities up by `(folder, library)`. A rename, reorder or
  delete of a shared folder is published to every library bound to it, and
  each library's assignment removals are queued before its own delete.
- An incoming category joins a folder with the same name (exact name first,
  then ignoring letter case) when the folder has no identity in that library
  and holds nothing of that library, or when its identity there is stale:
  - novels and books: the bound category is in neither the replica nor the
    outbox;
  - comics: the bound category belongs to another desktop and the folder holds
    no comics.
- A folder that holds unpublished comics or books is never joined. Their
  assignments are published when the folder is bound through its own flow.
- Joining a folder never renames it. On a shared folder, an incoming record
  only changes the name or order fields that differ from what that same
  identity last carried, so a replay does not undo another library's rename.
- Re-pairing with another desktop drops only the old comic identity and keeps
  the folder and its comics. When the new desktop can create categories, the
  catalog holds back the remote category of the same name until the folder is
  bound to it, which publishes the folder's comic assignments.
- When the current desktop no longer lists a comic category, a folder shared
  with novels or books (or one holding them) keeps existing. Only its desktop
  comic assignments and the comic identity are removed.

## Known limitations

- If the new desktop cannot create categories, re-pairing can leave two
  folders with the same name: the old one with its comics, and the desktop's.
  Nothing is lost, and the user can move the comics and delete the old folder.
- Deleting a comic category on the desktop and creating it again with the
  same name produces a new folder on the phone for the new category.
- A rename that arrives from one library is not republished to the other
  libraries of a shared folder until the folder is next edited on the phone.

## Rollback

There is no automatic downgrade. An older build at schema 55 would see a folder
with several identities. Its lookups by folder expect at most one row and
would fail on a shared folder, so a downgrade should first keep one identity
per folder (preferring `MANGA`) and drop the rest:

```sql
DELETE FROM aethon_category_identity
WHERE rowid NOT IN (
    SELECT rowid FROM aethon_category_identity AS kept
    WHERE kept.local_category_id = aethon_category_identity.local_category_id
    ORDER BY CASE kept.content_scope WHEN 'MANGA' THEN 0 ELSE 1 END, kept.entity_id
    LIMIT 1
);
```

The desktop keeps the dropped categories. After an upgrade again they join the
same folder by name.
