import jsQR from "jsqr";
import QRCode from "qrcode";

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the QR image file."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("QR image file did not produce a usable data URL."));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("Could not load the QR image."));
    image.onload = () => resolve(image);
    image.src = src;
  });
}

/**
 * The phone's own camera opens this page, which hands the bundle in the link fragment (never sent
 * to a server) to the Epigraph app as `epigraph://pair?b=`.
 */
export const SYNCD_PAIRING_PAGE_URL = "https://johnnylord1.github.io/Epigraph/pair/";
const SYNCD_PAIRING_APP_PREFIX = "epigraph://pair?b=";

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(data: string): string {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

/**
 * Wraps a bundle in the pairing page link. Pretty-printed JSON wastes QR modules, and a denser code
 * is harder for phone cameras to read, so the JSON is compacted first. Anything else is kept as is.
 */
export function syncdPairingLink(payload: string): string {
  try {
    return `${SYNCD_PAIRING_PAGE_URL}#${toBase64Url(JSON.stringify(JSON.parse(payload)))}`;
  } catch {
    return payload;
  }
}

/** The bundle inside a pairing link, or `scanned` unchanged (older desktops put raw JSON in the QR). */
export function syncdBundleFromQr(scanned: string): string {
  const text = scanned.trim();
  let data: string | null = null;
  if (text.startsWith(`${SYNCD_PAIRING_PAGE_URL}#`)) {
    data = text.slice(SYNCD_PAIRING_PAGE_URL.length + 1);
  } else if (text.startsWith(SYNCD_PAIRING_APP_PREFIX)) {
    data = text.slice(SYNCD_PAIRING_APP_PREFIX.length).split("&")[0];
  }
  if (!data) return scanned;
  try {
    const bundle = fromBase64Url(data);
    return bundle.trimStart().startsWith("{") ? bundle : scanned;
  } catch {
    return scanned;
  }
}

export async function buildSyncdQrDataUrl(payload: string): Promise<string> {
  // Phone scanners expect dark modules on a light background with a 4-module quiet zone;
  // inverted or transparent codes are not detected by many camera decoders.
  return QRCode.toDataURL(syncdPairingLink(payload), {
    errorCorrectionLevel: "M",
    margin: 4,
    scale: 8,
    color: {
      dark: "#000000ff",
      light: "#ffffffff",
    },
  });
}

export async function decodeSyncdQrDataUrl(dataUrl: string): Promise<string> {
  const image = await loadImageElement(dataUrl);
  const canvas = document.createElement("canvas");
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  if (!width || !height) {
    throw new Error("QR image has invalid dimensions.");
  }

  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Could not decode the QR image on this desktop.");
  }

  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const decoded = jsQR(pixels.data, pixels.width, pixels.height);
  if (!decoded?.data) {
    throw new Error("No readable sync QR payload was found in the selected image.");
  }

  return syncdBundleFromQr(decoded.data);
}

export async function decodeSyncdQrFile(file: File): Promise<string> {
  const dataUrl = await fileToDataUrl(file);
  return decodeSyncdQrDataUrl(dataUrl);
}
