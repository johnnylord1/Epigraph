import JSZip from "jszip";

export interface ExternalExtensionApkInspection {
  manifestEntry: string;
  dexEntries: string[];
}

function declaresExtension(bytes: Uint8Array): boolean {
  // Android ResourceTypes.h: compiled XML chunks and string-pool references.
  const invalid = () => { throw new Error("This APK has an invalid or incomplete Android manifest."); };
  if (bytes.length < 8) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 3 || view.getUint16(2, true) !== 8 || view.getUint32(4, true) !== bytes.length) return invalid();
  let strings: string[] = [];
  let found = false;
  const elements: string[] = [];
  let rootSeen = false;
  for (let pos = 8; pos < bytes.length;) {
    if (pos + 8 > bytes.length) return invalid();
    const type = view.getUint16(pos, true);
    const headerSize = view.getUint16(pos + 2, true);
    const size = view.getUint32(pos + 4, true);
    const end = pos + size;
    if (headerSize < 8 || size < headerSize || end > bytes.length) return invalid();
    if (type === 1) {
      if (headerSize < 28) return invalid();
      const count = view.getUint32(pos + 8, true);
      const utf8 = Boolean(view.getUint32(pos + 16, true) & 0x100);
      const start = pos + view.getUint32(pos + 20, true);
      if (count > 65535 || pos + headerSize + count * 4 > end || start < pos + headerSize + count * 4 || start > end) return invalid();
      strings = [];
      for (let index = 0; index < count; index++) {
        let cursor = start + view.getUint32(pos + headerSize + index * 4, true);
        const length = () => {
          if (cursor + (utf8 ? 1 : 2) > end) return invalid();
          const first = utf8 ? view.getUint8(cursor++) : view.getUint16((cursor += 2) - 2, true);
          if (!(first & (utf8 ? 0x80 : 0x8000))) return first;
          if (cursor + (utf8 ? 1 : 2) > end) return invalid();
          const second = utf8 ? view.getUint8(cursor++) : view.getUint16((cursor += 2) - 2, true);
          return (first & (utf8 ? 0x7f : 0x7fff)) * (utf8 ? 256 : 65536) + second;
        };
        let countUnits = length();
        if (utf8) countUnits = length();
        const byteCount = countUnits * (utf8 ? 1 : 2);
        if (cursor + byteCount + (utf8 ? 1 : 2) > end) return invalid();
        strings.push(new TextDecoder(utf8 ? "utf-8" : "utf-16le", { fatal: true }).decode(bytes.subarray(cursor, cursor + byteCount)));
      }
    } else if (type === 0x102) {
      if (headerSize < 16 || size < headerSize + 20) return invalid();
      const ext = pos + headerSize;
      const name = strings[view.getUint32(ext + 4, true)];
      if (!name || (!rootSeen && name !== "manifest")) return invalid();
      rootSeen = true;
      const attributeStart = view.getUint16(ext + 8, true);
      const attributeSize = view.getUint16(ext + 10, true);
      const count = view.getUint16(ext + 12, true);
      if (attributeStart < 20 || attributeSize < 20 || ext + attributeStart + count * attributeSize > end) return invalid();
      const attributes: Record<string, string> = {};
      for (let index = 0; index < count; index++) {
        const attr = ext + attributeStart + index * attributeSize;
        const key = strings[view.getUint32(attr + 4, true)];
        const stringIndex = view.getUint8(attr + 15) === 3 ? view.getUint32(attr + 16, true) : view.getUint32(attr + 8, true);
        if (key && stringIndex !== 0xffffffff) attributes[key] = strings[stringIndex] ?? "";
      }
      if (name === "meta-data" && elements.at(-1) === "application"
        && ["tachiyomi.extension.class", "tachiyomi.extension.factory"].includes(attributes.name)
        && attributes.value?.trim()) found = true;
      elements.push(name);
    } else if (type === 0x103) {
      if (headerSize < 16 || size < headerSize + 8 || elements.pop() !== strings[view.getUint32(pos + headerSize + 4, true)]) return invalid();
    }
    pos = end;
  }
  if (!rootSeen || elements.length) return invalid();
  return found;
}

function validateDex(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (bytes.length < 112 || !/^dex\n0(?:35|37|38|39|40|41)\0$/.test(magic)
    || view.getUint32(32, true) !== bytes.length
    || ![112, 120].includes(view.getUint32(36, true))
    || view.getUint32(40, true) !== 0x12345678) {
    throw new Error("This APK has invalid or incomplete DEX content.");
  }
}

export async function inspectExternalExtensionApk(
  input: Blob | Uint8Array | ArrayBuffer,
  filename: string,
): Promise<ExternalExtensionApkInspection> {
  if (!filename.trim().toLowerCase().endsWith(".apk")) {
    throw new Error("Choose a file with the .apk extension.");
  }

  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(input, { checkCRC32: true });
  } catch {
    throw new Error("This is not a valid APK or the file is incomplete.");
  }

  const entries = Object.keys(archive.files);
  const manifestEntry = entries.find((entry) => entry.toLowerCase() === "androidmanifest.xml");
  if (!manifestEntry) throw new Error("This APK has no Android manifest.");

  const dexEntries = entries.filter((entry) => /^classes(?:\d+)?\.dex$/i.test(entry));
  if (dexEntries.length === 0) throw new Error("This APK has no executable DEX content.");

  let manifest: Uint8Array;
  try {
    manifest = await archive.file(manifestEntry)!.async("uint8array");
  } catch {
    throw new Error("This is not a valid APK or the manifest is incomplete.");
  }

  if (!declaresExtension(manifest)) {
    throw new Error("This APK is not a Tachiyomi or Mihon extension.");
  }

  for (const entry of dexEntries) validateDex(await archive.file(entry)!.async("uint8array"));

  return { manifestEntry, dexEntries };
}
