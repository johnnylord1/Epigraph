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

export async function buildSyncdQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 1,
    scale: 8,
    color: {
      dark: "#f5f0ff",
      light: "#00000000",
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

  return decoded.data;
}

export async function decodeSyncdQrFile(file: File): Promise<string> {
  const dataUrl = await fileToDataUrl(file);
  return decodeSyncdQrDataUrl(dataUrl);
}
