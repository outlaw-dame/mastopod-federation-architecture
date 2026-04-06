export async function processVideo(input: Buffer, mimeType: string): Promise<{
  buffer: Buffer;
  mimeType: string;
}> {
  return {
    buffer: input,
    mimeType
  };
}
