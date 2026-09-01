// Small compiled Android container fixture for structural preflight tests.
// Installation compatibility is certified separately with the pinned real APK.
export function compiledExtensionManifest(extension = true): Uint8Array {
  const strings = ["manifest", "application", "meta-data", "name", "value", extension ? "tachiyomi.extension.class" : "ordinary.application", ".Fixture"];
  const encoded = strings.map((value) => {
    const bytes = new Uint8Array(2 + (value.length + 1) * 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, value.length, true);
    for (let i = 0; i < value.length; i++) view.setUint16(2 + i * 2, value.charCodeAt(i), true);
    return bytes;
  });
  const poolSize = 28 + strings.length * 4 + encoded.reduce((total, value) => total + value.length, 0);
  const pool = new Uint8Array(Math.ceil(poolSize / 4) * 4);
  const p = new DataView(pool.buffer);
  p.setUint16(0, 1, true); p.setUint16(2, 28, true); p.setUint32(4, pool.length, true);
  p.setUint32(8, strings.length, true); p.setUint32(20, 28 + strings.length * 4, true);
  let offset = 0;
  encoded.forEach((value, index) => {
    p.setUint32(28 + index * 4, offset, true);
    pool.set(value, 28 + strings.length * 4 + offset);
    offset += value.length;
  });
  function node(name: number, end = false, attributes: number[][] = []) {
    const bytes = new Uint8Array(end ? 24 : 36 + attributes.length * 20);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, end ? 0x103 : 0x102, true); view.setUint16(2, 16, true); view.setUint32(4, bytes.length, true);
    view.setUint32(12, 0xffffffff, true); view.setUint32(16, 0xffffffff, true); view.setUint32(20, name, true);
    if (!end) {
      view.setUint16(24, 20, true); view.setUint16(26, 20, true); view.setUint16(28, attributes.length, true);
      attributes.forEach(([nameIndex, valueIndex], index) => {
        const pos = 36 + index * 20;
        view.setUint32(pos, 0xffffffff, true); view.setUint32(pos + 4, nameIndex, true); view.setUint32(pos + 8, valueIndex, true);
        view.setUint16(pos + 12, 8, true); view.setUint8(pos + 15, 3); view.setUint32(pos + 16, valueIndex, true);
      });
    }
    return bytes;
  }
  const chunks = [pool, node(0), node(1), node(2, false, [[3, 5], [4, 6]]), node(2, true), node(1, true), node(0, true)];
  const bytes = new Uint8Array(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  const header = new DataView(bytes.buffer);
  header.setUint16(0, 3, true); header.setUint16(2, 8, true); header.setUint32(4, bytes.length, true);
  let pos = 8;
  for (const chunk of chunks) { bytes.set(chunk, pos); pos += chunk.length; }
  return bytes;
}

export function dexHeaderFixture(): Uint8Array {
  const bytes = new Uint8Array(112);
  bytes.set(new TextEncoder().encode("dex\n035\0"));
  const view = new DataView(bytes.buffer);
  view.setUint32(32, bytes.length, true); view.setUint32(36, 112, true); view.setUint32(40, 0x12345678, true);
  return bytes;
}
