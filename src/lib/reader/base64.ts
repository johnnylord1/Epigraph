// Downloaded pages cross the detached reader channel as base64 twice (the page, then the sealed message), several
// megabytes each. Chromium 140+ encodes natively; elsewhere the binary string is built in large chunks, since
// adding one character at a time is what made large chapters take seconds to open.

type Alphabet = "base64" | "base64url";

interface NativeBase64Bytes {
  toBase64?(options?: { alphabet?: Alphabet; omitPadding?: boolean }): string;
}

interface NativeBase64Constructor {
  fromBase64?(value: string, options?: { alphabet?: Alphabet }): Uint8Array<ArrayBuffer>;
}

const CHUNK = 0x8000;

export function encodeBase64(bytes: Uint8Array, alphabet: Alphabet = "base64", native = true): string {
  const encode = (bytes as NativeBase64Bytes).toBase64;
  if (native && typeof encode === "function") return encode.call(bytes, { alphabet, omitPadding: alphabet === "base64url" });
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + CHUNK) as unknown as number[]);
  }
  const base64 = btoa(binary);
  return alphabet === "base64url" ? base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : base64;
}

export function decodeBase64(value: string, alphabet: Alphabet = "base64", native = true): Uint8Array<ArrayBuffer> {
  const decode = (Uint8Array as NativeBase64Constructor).fromBase64;
  if (native && typeof decode === "function") return decode.call(Uint8Array, value, { alphabet });
  const base64 = alphabet === "base64url" ? value.replace(/-/g, "+").replace(/_/g, "/") : value;
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
