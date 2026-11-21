'use strict';
const fs = require('node:fs');
const values = JSON.parse(fs.readFileSync('/run/provider-secrets.json', 'utf8'));
const keys = ['SEMAPPS_JENA_PASSWORD', 'SEMAPPS_COOKIE_SECRET', 'ACTIVITYPODS_TOKEN', 'SIDECAR_TOKEN', 'SIGNING_API_TOKEN', 'ATPROTO_MIGRATION_SECRET_ENC_KEY_HEX', 'OAUTH_REFRESH_TOKEN_ENC_KEY_HEX'];
if (Object.keys(values).length !== keys.length || keys.some(k => !/^[a-f0-9]{64}$/.test(values[k] || ''))) {
  throw new Error('Invalid provider staging secret configuration');
}
for (const key of keys) process.env[key] = values[key];
if (process.env.NODE_ENV !== 'production' || Object.keys(process.env).some(k => k.endsWith('_DISPOSABLE'))) {
  throw new Error('Provider staging must retain production release gates');
}
// Root reads the owner-private bind mount; the broker runs without root rights.
process.setgroups([]);
process.setgid(1000);
process.setuid(1000);
require('/app/scripts/run-moleculer-fabric').run();
