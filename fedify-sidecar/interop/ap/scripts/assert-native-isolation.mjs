import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function listenerPresent(port) {
 return await new Promise((resolve, reject) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setTimeout(2000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', error => {
    socket.destroy();
    if (error.code === 'ECONNREFUSED') resolve(false);
    else reject(new Error('native isolation could not establish sidecar listener absence'));
  });
  socket.once('timeout', () => {
    socket.destroy(); reject(new Error('native isolation listener probe timed out'));
  });
});
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const [output] = process.argv.slice(2);
if (!output) throw new Error('usage: assert-native-isolation.mjs <output.json>');
const sidecarListening = await listenerPresent(8080);
if (sidecarListening) throw new Error('native proof cannot run with a sidecar listener on 8080');
fs.writeFileSync(output, JSON.stringify({ ok: true, sidecarListening, checkedHost: '127.0.0.1', checkedPort: 8080 }) + '\n');
}
