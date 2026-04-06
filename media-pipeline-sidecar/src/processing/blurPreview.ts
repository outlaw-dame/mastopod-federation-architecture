import sharp from 'sharp';

export async function generateBlurPreview(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .resize(32, 32, { fit: 'inside' })
    .blur(10)
    .webp({ quality: 40 })
    .toBuffer();
}
