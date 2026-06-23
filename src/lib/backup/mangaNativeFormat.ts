import pako from "pako";

const GZIP_MAGIC_1 = 0x1f;
const GZIP_MAGIC_2 = 0x8b;

export type MangaNativeBackupFormat = "tachibk" | "proto-gz" | "proto";

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

export function isGzipBytes(bytes: Uint8Array | ArrayBuffer): boolean {
  const data = toUint8Array(bytes);
  return data[0] === GZIP_MAGIC_1 && data[1] === GZIP_MAGIC_2;
}

export function normalizeNativeMangaBackupBytes(
  bytes: Uint8Array | ArrayBuffer,
  format: MangaNativeBackupFormat,
): Uint8Array {
  const data = toUint8Array(bytes);
  const gzipped = isGzipBytes(data);

  if (format === "tachibk") {
    return data;
  }

  if (format === "proto-gz") {
    return gzipped ? data : pako.gzip(data);
  }

  return gzipped ? pako.ungzip(data) : data;
}

export function mangaNativeBackupExtension(format: MangaNativeBackupFormat): ".tachibk" | ".proto.gz" | ".proto" {
  switch (format) {
    case "proto-gz":
      return ".proto.gz";
    case "proto":
      return ".proto";
    default:
      return ".tachibk";
  }
}
