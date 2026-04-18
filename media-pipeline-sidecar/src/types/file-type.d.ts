declare module 'file-type' {
  export function fileTypeFromBuffer(
    input: Uint8Array | ArrayBuffer
  ): Promise<{ ext: string; mime: string } | undefined>;
}
