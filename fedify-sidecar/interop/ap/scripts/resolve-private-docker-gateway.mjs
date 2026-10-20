#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';

const containerId = process.argv[2];
if (!containerId || !/^[a-f0-9]{12,64}$/u.test(containerId)) {
  throw new Error('A resolved Docker container ID is required');
}

const output = execFileSync(
  'docker',
  ['inspect', containerId, '--format', '{{range .NetworkSettings.Networks}}{{println .Gateway}}{{end}}'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
const gateway = output.split(/\r?\n/u).map((value) => value.trim()).find(Boolean);
const octets = gateway?.split('.').map((part) => Number.parseInt(part, 10)) ?? [];
const privateIpv4 = gateway && isIP(gateway) === 4 && (
  octets[0] === 10 ||
  (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
  (octets[0] === 192 && octets[1] === 168)
);

if (!privateIpv4) {
  throw new Error(`Proof service must bind only to a private Docker gateway, got ${gateway ?? 'none'}`);
}

// Colima and Docker Desktop forward their private host alias to macOS
// loopback; their VM gateway is not an address the macOS host can bind.
// Native Linux exposes the bridge gateway directly on the host.
process.stdout.write(`${process.platform === 'darwin' ? '127.0.0.1' : gateway}\n`);
