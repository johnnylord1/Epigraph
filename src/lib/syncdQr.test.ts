import { createRequire } from "node:module";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { buildSyncdQrDataUrl } from "./syncdQr";

// pngjs is a dependency of qrcode, not of Epigraph; resolve it through qrcode.
const requireFromQrcode = createRequire(createRequire(import.meta.url).resolve("qrcode"));
const { PNG } = requireFromQrcode("pngjs") as {
  PNG: { sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } } };
};

function readPng(dataUrl: string) {
  return PNG.sync.read(Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
}

describe("buildSyncdQrDataUrl", () => {
  const bundle = JSON.stringify(
    {
      version: 1,
      pairingCode: "000000",
      syncdBaseUrl: "https://192.0.2.10:4777",
      tlsCertSha256: "a".repeat(64),
    },
    null,
    2,
  );

  it("renders a phone-scannable code: dark modules on an opaque light quiet zone", async () => {
    const png = readPng(await buildSyncdQrDataUrl(bundle));
    // Top-left pixel sits in the quiet zone and must be opaque white, not transparent.
    expect(Array.from(png.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    // The quiet zone is 4 modules of 8px each before the finder pattern starts.
    const finderStart = (32 * png.width + 32) * 4;
    expect(Array.from(png.data.subarray(finderStart, finderStart + 4))).toEqual([0, 0, 0, 255]);
  });

  it("encodes compact JSON that decodes back to the same bundle", async () => {
    const png = readPng(await buildSyncdQrDataUrl(bundle));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(JSON.stringify(JSON.parse(bundle)));
  });

  it("keeps non-JSON payloads unchanged", async () => {
    const png = readPng(await buildSyncdQrDataUrl("epigraph-pairing-raw"));
    expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(
      "epigraph-pairing-raw",
    );
  });
});
