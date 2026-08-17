#!/usr/bin/env node

import { runAdspRemoteFixtureCli } from "../src/adsp/RemoteFixtureCli.js";

runAdspRemoteFixtureCli(process.argv.slice(2), process.env)
  .then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
  .catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.exitCode = 1;
  });
