import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseLnReaderNovelsBackup } from "./lnreaderBackup";
import { parseMihonBackup } from "./mihonBackup";

const j2kPath = process.env.EPIGRAPH_J2K_BACKUP ?? "";
const yokaiPath = process.env.EPIGRAPH_YOKAI_BACKUP ?? "";
const lnreaderPath = process.env.EPIGRAPH_LNREADER_BACKUP ?? "";

describe.runIf(Boolean(j2kPath && yokaiPath && lnreaderPath && existsSync(j2kPath) && existsSync(yokaiPath) && existsSync(lnreaderPath)))(
  "supplied backup fixture certification",
  () => {
    it("keeps library and history records distinct in J2K and Yokai", async () => {
      const j2k = await parseMihonBackup(await readFile(j2kPath), []);
      const yokai = await parseMihonBackup(await readFile(yokaiPath), []);

      expect(j2k.backupManga).toHaveLength(686);
      expect(j2k.mangaMessages).toHaveLength(2884);
      expect(yokai.backupManga).toHaveLength(684);
      expect(yokai.mangaMessages).toHaveLength(2793);
    });

    it("extracts the complete LNReader library and its source provenance", async () => {
      const parsed = await parseLnReaderNovelsBackup(await readFile(lnreaderPath));

      expect(parsed.entries).toHaveLength(9);
      expect(parsed.chapters).toHaveLength(6936);
      expect(parsed.repositories).toHaveLength(2);
      expect(parsed.plugins).toHaveLength(19);
      expect(parsed.plugins?.every((plugin) => plugin.repositoryUrl)).toBe(true);
      expect(parsed.repositories).toEqual([
        {
          url: "https://raw.githubusercontent.com/lnreader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
          name: "LNReader plugins",
        },
        {
          url: "https://raw.githubusercontent.com/johnnylord1/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
          name: "johnnylord1 plugins",
        },
      ]);
      expect(parsed.plugins?.find((plugin) => plugin.id === "mahoureader")).toMatchObject({
        name: "Mahou Reader",
        repositoryUrl: "https://raw.githubusercontent.com/johnnylord1/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json",
      });
      expect(parsed.entries.find((entry) => entry.source?.pluginId === "mahoureader")?.source?.repositoryUrl)
        .toBe("https://raw.githubusercontent.com/johnnylord1/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json");
    });
  },
);
