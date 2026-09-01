import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { inspectExternalExtensionApk } from "./apkPreflight";
import { compiledExtensionManifest, dexHeaderFixture } from "../../test/fixtures/extensionApk";

async function buildApk(manifest: string, includeDex = true) {
  const zip = new JSZip();
  zip.file("AndroidManifest.xml", compiledExtensionManifest(manifest.startsWith("tachiyomi.")));
  if (includeDex) zip.file("classes.dex", dexHeaderFixture());
  return zip.generateAsync({ type: "uint8array" });
}

describe("external extension APK preflight", () => {
  it("rejects a renamed ZIP with marker text instead of compiled Android files", async () => {
    const archive = new JSZip();
    archive.file("AndroidManifest.xml", "tachiyomi.extension.class");
    archive.file("classes.dex", "not DEX");
    await expect(inspectExternalExtensionApk(await archive.generateAsync({ type: "uint8array" }), "fake.apk")).rejects.toThrow();
  });

  it("rejects truncated DEX content inside a complete ZIP", async () => {
    const archive = new JSZip();
    archive.file("AndroidManifest.xml", compiledExtensionManifest());
    archive.file("classes.dex", dexHeaderFixture().slice(0, 50));
    await expect(inspectExternalExtensionApk(await archive.generateAsync({ type: "uint8array" }), "truncated-code.apk")).rejects.toThrow("DEX");
  });
  it("accepts an APK that declares Tachiyomi extension metadata", async () => {
    const bytes = await buildApk("tachiyomi.extension.class");

    await expect(inspectExternalExtensionApk(bytes, "akuma.apk")).resolves.toMatchObject({
      manifestEntry: "AndroidManifest.xml",
      dexEntries: ["classes.dex"],
    });
  });

  it("rejects an ordinary Android APK before upload", async () => {
    const bytes = await buildApk("com.example.archiver.MainActivity");

    await expect(inspectExternalExtensionApk(bytes, "archiver.apk")).rejects.toThrow(
      "not a Tachiyomi or Mihon extension",
    );
  });

  it("rejects missing dex, corrupt, truncated, and renamed files", async () => {
    const missingDex = await buildApk("tachiyomi.extension.class", false);
    const valid = await buildApk("tachiyomi.extension.class");

    await expect(inspectExternalExtensionApk(missingDex, "missing-dex.apk")).rejects.toThrow("DEX");
    await expect(inspectExternalExtensionApk(new Uint8Array([1, 2, 3]), "corrupt.apk")).rejects.toThrow("valid APK");
    await expect(inspectExternalExtensionApk(valid.slice(0, 40), "truncated.apk")).rejects.toThrow("valid APK");
    await expect(inspectExternalExtensionApk(valid, "renamed.zip")).rejects.toThrow(".apk");
  });
});

describe.runIf(Boolean(process.env.EPIGRAPH_EXTENSION_APK))("real extension APK certification", () => {
  it("accepts the pinned extension artifact and rejects the supplied ordinary APK", async () => {
    const extensionPath = process.env.EPIGRAPH_EXTENSION_APK!;
    const ordinaryPath = process.env.EPIGRAPH_ORDINARY_APK!;

    await expect(inspectExternalExtensionApk(await readFile(extensionPath), extensionPath)).resolves.toBeTruthy();
    await expect(inspectExternalExtensionApk(await readFile(ordinaryPath), ordinaryPath)).rejects.toThrow(
      "not a Tachiyomi or Mihon extension",
    );
  });
});
