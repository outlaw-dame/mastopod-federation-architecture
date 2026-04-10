export function sha256HexToDigestMultibase(value?: string): string | undefined {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    return undefined;
  }

  return `u${Buffer.from(value, 'hex').toString('base64url')}`;
}