declare module "qrcode" {
  interface QrCodeToDataUrlOptions {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    margin?: number;
    scale?: number;
    color?: {
      dark?: string;
      light?: string;
    };
  }

  const QRCode: {
    toDataURL(text: string, options?: QrCodeToDataUrlOptions): Promise<string>;
  };

  export default QRCode;
}
