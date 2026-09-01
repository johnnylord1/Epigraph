import { describe, expect, it } from "vitest";
import { buildBackupDependencyPreview } from "./dependencyPreview";

describe("backup dependency preview", () => {
  it("deduplicates repositories and keeps plugins tied to their origin", () => {
    const preview = buildBackupDependencyPreview({
      titleCount: 9,
      chapterCount: 6936,
      mangaStores: [{ indexUrl: "https://repo.example/index.min.json/", name: "Keiyoushi" }],
      repositories: [
        { url: "https://repo.example/index.min.json", name: "Duplicate" },
        { url: "https://novels.example/plugins.min.json", name: "LNReader" },
      ],
      plugins: [
        { id: "plugin.mahou", name: "Mahou", repositoryUrl: "https://novels.example/plugins.min.json" },
      ],
    });

    expect(preview.repositories).toEqual([
      { url: "https://repo.example/index.min.json", name: "Keiyoushi" },
      { url: "https://novels.example/plugins.min.json", name: "LNReader" },
    ]);
    expect(preview.plugins).toEqual([
      { id: "plugin.mahou", name: "Mahou", repositoryUrl: "https://novels.example/plugins.min.json" },
    ]);
    expect(preview.titleCount).toBe(9);
    expect(preview.chapterCount).toBe(6936);
  });

  it("requires confirmation only when a restore can write repositories or plugins", () => {
    expect(buildBackupDependencyPreview({ titleCount: 1 }).requiresConfirmation).toBe(false);
    expect(buildBackupDependencyPreview({ repositories: [{ url: "https://repo.example/index.json" }] }).requiresConfirmation).toBe(true);
    expect(buildBackupDependencyPreview({ plugins: [{ id: "plugin.one" }] }).requiresConfirmation).toBe(true);
  });
});
