/** Rewrites empty BackupManga.memo (112) and BackupChapter.memo (13) to "{}".
 * Input and output are the UNCOMPRESSED Backup message. Returns the same array
 * instance when nothing changed or when the bytes are not a well-formed message. */
export function normalizeMihonMemoFields(backup: Uint8Array): Uint8Array {
  try {
    const result = rewriteBackup(backup);
    return result.changed ? result.bytes : backup;
  } catch {
    return backup;
  }
}

class Malformed extends Error {}

function encodeVarint(n: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return bytes;
}

function readVarint(bytes: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    if (pos >= bytes.length) throw new Malformed();
    const byte = bytes[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, pos];
    shift += 7;
  }
  throw new Malformed();
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/**
 * Walk a message body, applying a per-field transform.
 * The transform returns a replacement byte slice (key + value) or null to copy as-is.
 */
function walkFields(
  body: Uint8Array,
  transform: (fieldNo: number, wireType: number, valueStart: number, valueEnd: number) => Uint8Array | null,
): { bytes: Uint8Array; changed: boolean } {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  let anyChanged = false;

  while (pos < body.length) {
    const fieldStart = pos;
    const [tag, afterTag] = readVarint(body, pos);
    const fieldNo = tag >>> 3;
    const wireType = tag & 0x7;

    let valueStart: number;
    let valueEnd: number;

    switch (wireType) {
      case 0: {
        const [, end] = readVarint(body, afterTag);
        valueStart = afterTag;
        valueEnd = end;
        break;
      }
      case 1: {
        if (afterTag + 8 > body.length) throw new Malformed();
        valueStart = afterTag;
        valueEnd = afterTag + 8;
        break;
      }
      case 2: {
        const [len, afterLen] = readVarint(body, afterTag);
        if (afterLen + len > body.length) throw new Malformed();
        valueStart = afterLen;
        valueEnd = afterLen + len;
        break;
      }
      case 5: {
        if (afterTag + 4 > body.length) throw new Malformed();
        valueStart = afterTag;
        valueEnd = afterTag + 4;
        break;
      }
      default:
        throw new Malformed();
    }

    const replacement = transform(fieldNo, wireType, valueStart, valueEnd);
    if (replacement !== null) {
      chunks.push(replacement);
      anyChanged = true;
    } else {
      chunks.push(body.subarray(fieldStart, valueEnd));
    }

    pos = valueEnd;
  }

  if (!anyChanged) return { bytes: body, changed: false };
  return { bytes: concatChunks(chunks), changed: true };
}

function fieldKeyBytes(fieldNo: number, wireType: number): Uint8Array {
  return Uint8Array.from(encodeVarint(fieldNo * 8 + wireType));
}

const EMPTY_MEMO_REPLACEMENT = (fieldNo: number): Uint8Array => {
  const key = fieldKeyBytes(fieldNo, 2);
  return new Uint8Array([...key, 2, 0x7b, 0x7d]);
};

function rewriteChapter(body: Uint8Array): { bytes: Uint8Array; changed: boolean } {
  return walkFields(body, (fieldNo, wireType, valueStart, valueEnd) => {
    if (fieldNo === 13 && wireType === 2 && valueEnd - valueStart === 0) {
      return EMPTY_MEMO_REPLACEMENT(13);
    }
    return null;
  });
}

function rewriteManga(body: Uint8Array): { bytes: Uint8Array; changed: boolean } {
  return walkFields(body, (fieldNo, wireType, valueStart, valueEnd) => {
    if (fieldNo === 112 && wireType === 2 && valueEnd - valueStart === 0) {
      return EMPTY_MEMO_REPLACEMENT(112);
    }
    if (fieldNo === 16 && wireType === 2) {
      const result = rewriteChapter(body.subarray(valueStart, valueEnd));
      if (result.changed) {
        const key = fieldKeyBytes(16, 2);
        const len = Uint8Array.from(encodeVarint(result.bytes.length));
        return concatChunks([key, len, result.bytes]);
      }
    }
    return null;
  });
}

function rewriteBackup(body: Uint8Array): { bytes: Uint8Array; changed: boolean } {
  return walkFields(body, (fieldNo, wireType, valueStart, valueEnd) => {
    if (fieldNo === 1 && wireType === 2) {
      const result = rewriteManga(body.subarray(valueStart, valueEnd));
      if (result.changed) {
        const key = fieldKeyBytes(1, 2);
        const len = Uint8Array.from(encodeVarint(result.bytes.length));
        return concatChunks([key, len, result.bytes]);
      }
    }
    return null;
  });
}
