import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const execFile = promisify(execFileCallback);
const [output] = process.argv.slice(2);
if (!output) throw new Error('usage: capture-runtime-images.mjs <output.json>');
const run = async args => (await execFile('docker', args, { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout;
const containers = (await run(['ps', '--quiet'])).trim().split(/\s+/).filter(Boolean);
if (containers.length === 0 || containers.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('running container evidence is absent or invalid');
const imageIds = [...new Set((await run(['inspect', '--format', '{{.Image}}', ...containers])).trim().split(/\s+/))];
if (imageIds.some(id => !/^sha256:[a-f0-9]{64}$/.test(id))) throw new Error('container image identity is invalid');
const raw = JSON.parse(await run(['image', 'inspect', ...imageIds]));
// Never retain container environment, registry credentials, labels, or full inspect output.
const images = raw.map(image => ({ id: image.Id, repoDigests: image.RepoDigests ?? [],
  repoTags: image.RepoTags ?? [], architecture: image.Architecture, os: image.Os }));
const remoteFixtureModifications = process.env.TARGET === 'castopod'
  ? ['../castopod/HttpSignature.php', '../castopod/actor_compat.php', '../fixtures/php/interop-castopod.ini']
    .map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex') }))
  : [];
fs.writeFileSync(output, JSON.stringify({ schema: 'ap.interop.runtime-images.v1', images, remoteFixtureModifications }, null, 2) + '\n');
