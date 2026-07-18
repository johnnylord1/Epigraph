declare module "pako" {
  type BinaryInput = Uint8Array | ArrayBuffer | string;

  export function gzip(input: BinaryInput): Uint8Array<ArrayBuffer>;
  export function ungzip(input: BinaryInput): Uint8Array<ArrayBuffer>;

  const pako: {
    gzip: typeof gzip;
    ungzip: typeof ungzip;
  };

  export default pako;
}
