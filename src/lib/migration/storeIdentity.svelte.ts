import {
  persistMigrationIdentitySettings,
  store,
} from "../../store/state.svelte";
import {
  migrationIdentityRevision,
  type MigrationIdentityBridge,
  type MigrationIdentityRevision,
  type MigrationIdentitySettings,
} from "./identity";

function cloneSettings(): MigrationIdentitySettings {
  const clone = <T>(value: T): T => {
    try {
      return structuredClone(value);
    } catch {
      return JSON.parse(JSON.stringify(value)) as T;
    }
  };
  return {
    mangaLinks: clone(store.settings.mangaLinks ?? {}),
    novelLinks: clone(store.settings.novelLinks ?? {}),
    booksCategoryAssignments: clone(store.settings.booksCategoryAssignments ?? {}),
  };
}

function snapshot(profileId: string): MigrationIdentityRevision {
  const settings = cloneSettings();
  return {
    profileId,
    revision: migrationIdentityRevision(settings),
    settings,
  };
}

export function createStoreMigrationIdentityBridge(profileId: string): MigrationIdentityBridge {
  const read = async () => {
    const activeProfileId = store.runtimeResolvedLocalProfileId ?? store.settings.defaultLocalProfileId;
    if (activeProfileId !== profileId) {
      throw new Error("The active profile changed during migration.");
    }
    return snapshot(profileId);
  };
  return {
    profileId,
    read,
    async write(input) {
      const current = await read();
      if (current.revision !== input.expectedRevision) {
        throw new Error("Migration identity changed concurrently. No newer links or folders were overwritten.");
      }
      await persistMigrationIdentitySettings({
        profileId,
        ...input.next,
      });
      const persisted = await read();
      const expectedRevision = migrationIdentityRevision(input.next);
      if (persisted.revision !== expectedRevision) {
        throw new Error("Migration identity could not be verified after persistence.");
      }
      return persisted;
    },
  };
}
