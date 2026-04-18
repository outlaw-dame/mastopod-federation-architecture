import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256HexToDigestMultibase(value?: string): string | undefined {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    return undefined;
  }

  return `u${Buffer.from(value, 'hex').toString('base64url')}`;
}

export function sha256Buffer(input: Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });

  return hash.digest('hex');
}
