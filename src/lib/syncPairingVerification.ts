/**
 * Four digits both desktops show while a pairing waits for approval. They are derived from the
 * host certificate, so a different code means the request did not reach the expected computer.
 */
export function pairingVerificationCode(tlsCertSha256: string): string {
  let hash = 0x811c9dc5;
  for (const char of tlsCertSha256.trim().toLowerCase().replace(/[^0-9a-f]/g, "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(hash % 10_000).padStart(4, "0");
}
