import { OAuthError, ensureNonEmptyString } from './OAuthErrors.js';
import { assertSafeTarget, fetchJsonWithRetry } from './SafeHttpClient.js';

export interface ExternalDiscoveryResult {
  identifier: string;
  did: string;
  handle?: string;
  pdsEndpoint: string;
  authorizationServer: string;
  protectedResourceMetadata: Record<string, unknown>;
  authorizationServerMetadata: Record<string, unknown>;
}

export interface OAuthExternalDiscoveryBrokerOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  allowLocalhostHttp?: boolean;
}

function maybeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export class OAuthExternalDiscoveryBroker {
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly allowLocalhostHttp: boolean;

  constructor(opts: OAuthExternalDiscoveryBrokerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 6_000;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.allowLocalhostHttp = opts.allowLocalhostHttp ?? false;
  }

  async discover(identifierInput: string): Promise<ExternalDiscoveryResult> {
    const identifier = ensureNonEmptyString(identifierInput, 320, 'identifier');
    const did = identifier.startsWith('did:')
      ? identifier
      : await this.resolveHandleToDid(identifier);

    const didDoc = await this.resolveDidDocument(did);
    const service = this.findAtprotoService(didDoc);
    const pdsEndpoint = ensureNonEmptyString(service, 2048, 'pdsEndpoint');

    const pdsUrl = new URL(pdsEndpoint);
    await assertSafeTarget(pdsUrl, this.allowLocalhostHttp);

    const protectedResourceUrl = new URL('/.well-known/oauth-protected-resource', pdsUrl);
    const protectedResourceMetadata = await fetchJsonWithRetry(protectedResourceUrl, {
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
    });

    const authServers = stringArray(protectedResourceMetadata['authorization_servers']);
    if (!authServers.length) {
      throw new OAuthError('invalid_request', 400, 'No authorization server discovered for external account');
    }

    const authorizationServer = authServers[0]!;
    const authServerUrl = new URL(authorizationServer);
    await assertSafeTarget(authServerUrl, this.allowLocalhostHttp);

    const authServerMetadataUrl = new URL('/.well-known/oauth-authorization-server', authServerUrl);
    const authorizationServerMetadata = await fetchJsonWithRetry(authServerMetadataUrl, {
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
    });

    const sub = maybeString(authorizationServerMetadata['issuer']);
    if (!sub) {
      throw new OAuthError('invalid_request', 400, 'Discovered authorization server metadata is invalid');
    }

    const alsoKnownAs = stringArray(didDoc['alsoKnownAs']);
    const handle = alsoKnownAs
      .find((value) => value.startsWith('at://'))
      ?.replace(/^at:\/\//, '');

    return {
      identifier,
      did,
      handle,
      pdsEndpoint: pdsUrl.origin,
      authorizationServer: authServerUrl.origin,
      protectedResourceMetadata,
      authorizationServerMetadata,
    };
  }

  private async resolveHandleToDid(handle: string): Promise<string> {
    const normalized = ensureNonEmptyString(handle.toLowerCase(), 253, 'handle');
    const handleUrl = new URL(`https://${normalized}/.well-known/atproto-did`);
    await assertSafeTarget(handleUrl, false);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(handleUrl, {
        method: 'GET',
        headers: { accept: 'text/plain' },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new OAuthError('invalid_request', 400, `Unable to resolve handle ${normalized}`);
      }

      const did = ensureNonEmptyString((await res.text()).trim(), 320, 'did');
      if (!did.startsWith('did:')) {
        throw new OAuthError('invalid_request', 400, 'Resolved DID is invalid');
      }
      return did;
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      throw new OAuthError('temporarily_unavailable', 503, 'Handle resolution failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveDidDocument(did: string): Promise<Record<string, unknown>> {
    const normalizedDid = ensureNonEmptyString(did, 320, 'did');
    let didDocUrl: URL;

    if (normalizedDid.startsWith('did:plc:')) {
      didDocUrl = new URL(`https://plc.directory/${normalizedDid}`);
    } else if (normalizedDid.startsWith('did:web:')) {
      const host = normalizedDid.slice('did:web:'.length).replace(/:/g, '/');
      didDocUrl = new URL(`https://${host}/.well-known/did.json`);
    } else {
      throw new OAuthError('invalid_request', 400, 'Unsupported DID method');
    }

    await assertSafeTarget(didDocUrl, this.allowLocalhostHttp);
    const didDoc = await fetchJsonWithRetry(didDocUrl, {
      timeoutMs: this.timeoutMs,
      maxAttempts: this.maxAttempts,
    });

    const id = maybeString(didDoc['id']);
    if (!id || id !== normalizedDid) {
      throw new OAuthError('invalid_request', 400, 'DID document mismatch');
    }

    const verificationMethods = Array.isArray(didDoc['verificationMethod'])
      ? didDoc['verificationMethod']
      : [];
    const hasAtprotoKey = verificationMethods.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const idValue = maybeString((entry as Record<string, unknown>)['id']);
      return !!idValue && idValue.endsWith('#atproto');
    });

    if (!hasAtprotoKey) {
      throw new OAuthError('invalid_request', 400, 'DID document missing #atproto verification method');
    }

    return didDoc;
  }

  private findAtprotoService(didDoc: Record<string, unknown>): string {
    const services = Array.isArray(didDoc['service']) ? didDoc['service'] : [];
    const match = services.find((service) => {
      if (!service || typeof service !== 'object') return false;
      const asRecord = service as Record<string, unknown>;
      const typeValue = maybeString(asRecord['type']);
      return typeValue === 'AtprotoPersonalDataServer';
    });

    if (!match || typeof match !== 'object') {
      throw new OAuthError('invalid_request', 400, 'DID document missing PDS service endpoint');
    }

    const endpoint = maybeString((match as Record<string, unknown>)['serviceEndpoint']);
    if (!endpoint) {
      throw new OAuthError('invalid_request', 400, 'PDS service endpoint is invalid');
    }
    return endpoint;
  }
}
