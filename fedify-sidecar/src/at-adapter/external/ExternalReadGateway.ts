import { XrpcError, XrpcErrors, type XrpcErrorName } from '../xrpc/middleware/XrpcErrorMapper.js';
import {
  ExternalPdsClient,
  ExternalPdsClientError,
  type ExternalPdsResponse,
} from './ExternalPdsClient.js';

export class ExternalReadGateway {
  constructor(private readonly externalPdsClient: ExternalPdsClient) {}

  async getRecord(
    pdsUrl: string,
    repo: string,
    collection: string,
    rkey: string,
    cid?: string
  ): Promise<ExternalPdsResponse<unknown>> {
    try {
      return await this.externalPdsClient.getRecord(pdsUrl, repo, collection, rkey, cid);
    } catch (error) {
      throw mapExternalReadError(error, 'RecordNotFound');
    }
  }

  async getLatestCommit(
    pdsUrl: string,
    did: string
  ): Promise<ExternalPdsResponse<unknown>> {
    try {
      return await this.externalPdsClient.getLatestCommit(pdsUrl, did);
    } catch (error) {
      throw mapExternalReadError(error, 'RepoNotFound');
    }
  }

  async getRepo(
    pdsUrl: string,
    did: string,
    since?: string
  ): Promise<ExternalPdsResponse<Uint8Array>> {
    try {
      return await this.externalPdsClient.getRepo(pdsUrl, did, since);
    } catch (error) {
      throw mapExternalReadError(error, 'RepoNotFound');
    }
  }

  async listRecords(
    pdsUrl: string,
    query: {
      repo: string;
      collection: string;
      limit?: number;
      cursor?: string;
      reverse?: boolean;
    }
  ): Promise<ExternalPdsResponse<unknown>> {
    try {
      return await this.externalPdsClient.listRecords(pdsUrl, query);
    } catch (error) {
      throw mapExternalReadError(error, 'RepoNotFound');
    }
  }

  async describeRepo(
    pdsUrl: string,
    repo: string
  ): Promise<ExternalPdsResponse<unknown>> {
    try {
      return await this.externalPdsClient.describeRepo(pdsUrl, repo);
    } catch (error) {
      throw mapExternalReadError(error, 'RepoNotFound');
    }
  }
}

function mapExternalReadError(
  error: unknown,
  defaultNotFound: Extract<XrpcErrorName, 'RepoNotFound' | 'RecordNotFound'>
): Error {
  if (!(error instanceof ExternalPdsClientError)) {
    return XrpcErrors.internal();
  }

  if (error.error && isKnownXrpcErrorName(error.error)) {
    return new XrpcError(
      error.status ?? 500,
      error.error,
      error.message || 'External PDS request failed'
    );
  }

  if (error.status === 400) {
    return XrpcErrors.invalidRequest(error.message);
  }

  if (error.status === 404) {
    return defaultNotFound === 'RecordNotFound'
      ? XrpcErrors.recordNotFound('external')
      : XrpcErrors.repoNotFound('external');
  }

  if (error.status === 429 || (error.status !== undefined && error.status >= 500)) {
    return new XrpcError(503, 'InternalServerError', 'External PDS is temporarily unavailable');
  }

  return XrpcErrors.internal();
}

function isKnownXrpcErrorName(value: string): value is XrpcErrorName {
  return new Set<XrpcErrorName>([
    'InvalidRequest',
    'NotFound',
    'RepoNotFound',
    'RecordNotFound',
    'HandleNotFound',
    'InvalidDid',
    'InvalidHandle',
    'InvalidCursor',
    'InvalidCollection',
    'InvalidRkey',
    'RepoDeactivated',
    'RepoTakendown',
    'UnsupportedAlgorithm',
    'InternalServerError',
    'AuthRequired',
    'Forbidden',
    'UnsupportedCollection',
    'WriteNotAllowed',
    'WriteTimeout',
    'InvalidSwap',
  ]).has(value as XrpcErrorName);
}
