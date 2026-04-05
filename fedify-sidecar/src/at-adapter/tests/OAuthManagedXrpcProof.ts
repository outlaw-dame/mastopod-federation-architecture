/* eslint-disable no-console */

async function main(): Promise<void> {
  const base = process.env["OAUTH_PROOF_BASE_URL"] || 'http://localhost:8080';
  const xrpcPath = process.env["OAUTH_PROOF_XRPC_PATH"] || '/xrpc/com.atproto.server.describeServer';
  const accessToken = process.env["OAUTH_PROOF_ACCESS_TOKEN"];
  const dpop = process.env["OAUTH_PROOF_DPOP"];

  if (!accessToken || !dpop) {
    throw new Error('Set OAUTH_PROOF_ACCESS_TOKEN and OAUTH_PROOF_DPOP');
  }

  const response = await fetch(`${base}${xrpcPath}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      dpop,
    },
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`XRPC call failed ${response.status}: ${body}`);
  }

  console.log('[OAuthManagedXrpcProof] PASS');
  console.log(body);
}

main().catch((error) => {
  console.error('[OAuthManagedXrpcProof] FAIL', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
