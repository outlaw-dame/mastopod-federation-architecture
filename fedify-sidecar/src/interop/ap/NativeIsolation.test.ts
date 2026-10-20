import net from 'node:net';
import { describe, it, expect } from 'vitest';
// @ts-expect-error proof scripts are plain Node modules
import { listenerPresent } from '../../../interop/ap/scripts/assert-native-isolation.mjs';

describe('native lane listener isolation', () => {
  it('distinguishes an actual listener from a refused connection', async () => {
    const server = net.createServer(socket => socket.end());
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try { expect(await listenerPresent(port)).toBe(true); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    expect(await listenerPresent(port)).toBe(false);
  });
});
