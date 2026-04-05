/* eslint-disable no-console */

async function main(): Promise<void> {
  const base = process.env["OAUTH_PROOF_BASE_URL"] || 'http://localhost:8080';
  const url = `${base}/.well-known/oauth-protected-resource`;

  const response = await fetch(url, { method: 'GET' });
  const json = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    throw new Error(`Protected resource metadata failed: ${response.status} ${JSON.stringify(json)}`);
  }

  if (!json["resource"] || !Array.isArray(json["authorization_servers"])) {
    throw new Error('Protected resource metadata missing required fields');
  }

  console.log('[OAuthProtectedResourceProof] PASS');
  console.log(JSON.stringify({
    resource: json["resource"],
    authorization_servers: json["authorization_servers"],
  }, null, 2));
}

main().catch((error) => {
  console.error('[OAuthProtectedResourceProof] FAIL', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
