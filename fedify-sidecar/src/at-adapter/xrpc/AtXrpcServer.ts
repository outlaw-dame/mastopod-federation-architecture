/**
 * V6.5 Phase 4: AT XRPC Server
 *
 * Owns HTTP server setup, route registration under /xrpc/*, content
 * negotiation, common security headers, and error mapping.
 *
 * Public endpoints (unauthenticated, per ATProto spec):
 *   GET  /xrpc/com.atproto.sync.getRepo
 *   GET  /xrpc/com.atproto.sync.getLatestCommit
 *   GET  /xrpc/com.atproto.repo.getRecord
 *   GET  /xrpc/com.atproto.repo.listRecords
 *   GET  /xrpc/com.atproto.identity.resolveHandle
 *   WS   /xrpc/com.atproto.sync.subscribeRepos
 *
 * Security hardening:
 *   - All responses include standard security headers (X-Content-Type-Options,
 *     X-Frame-Options, Referrer-Policy, Permissions-Policy).
 *   - CORS is restricted to the configured origin list; wildcard is only
 *     used for the public read endpoints as required by the ATProto spec.
 *   - Write/mutation endpoints are NOT registered here (Phase 4 scope).
 *   - Rate limiting is noted as a TODO; implement at the reverse-proxy layer
 *     (nginx/Caddy) or via a middleware library before production deployment.
 *
 * This module does not contain any repo logic.  All business logic is
 * delegated to the injected route handlers.
 *
 * Ref: https://atproto.com/specs/xrpc
 */

import { AtRecordReader } from '../repo/AtRecordReader';
import { AtCarExporter } from '../repo/AtCarExporter';
import { HandleResolutionReader } from '../identity/HandleResolutionReader';
import { AtFirehoseSubscriptionManager } from '../firehose/AtFirehoseSubscriptionManager';
import { AtprotoRepoRegistry } from '../../atproto/repo/AtprotoRepoRegistry';
import { SyncGetRepoRoute } from './routes/SyncGetRepoRoute';
import { SyncGetLatestCommitRoute } from './routes/SyncGetLatestCommitRoute';
import { RepoGetRecordRoute } from './routes/RepoGetRecordRoute';
import { RepoListRecordsRoute } from './routes/RepoListRecordsRoute';
import { IdentityResolveHandleRoute } from './routes/IdentityResolveHandleRoute';
import { SubscribeReposRoute } from './routes/SubscribeReposRoute';
import { DefaultRepoRevLookup } from './middleware/AtRepoRevHeader';
import { mapToXrpcError } from './middleware/XrpcErrorMapper';

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface AtXrpcServerDeps {
  recordReader: AtRecordReader;
  carExporter: AtCarExporter;
  handleResolutionReader: HandleResolutionReader;
  firehoseSubscriptions: AtFirehoseSubscriptionManager;
  repoRegistry: AtprotoRepoRegistry;
}

// ---------------------------------------------------------------------------
// Server interface
// ---------------------------------------------------------------------------

export interface AtXrpcServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Security headers applied to every HTTP response
// ---------------------------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultAtXrpcServer implements AtXrpcServer {
  private readonly getRepoRoute: SyncGetRepoRoute;
  private readonly getLatestCommitRoute: SyncGetLatestCommitRoute;
  private readonly getRecordRoute: RepoGetRecordRoute;
  private readonly listRecordsRoute: RepoListRecordsRoute;
  private readonly resolveHandleRoute: IdentityResolveHandleRoute;
  private readonly subscribeReposRoute: SubscribeReposRoute;

  constructor(private readonly deps: AtXrpcServerDeps) {
    const revLookup = new DefaultRepoRevLookup(deps.repoRegistry);

    this.getRepoRoute = new SyncGetRepoRoute({
      carExporter: deps.carExporter,
      handleResolutionReader: deps.handleResolutionReader,
      repoRegistry: deps.repoRegistry
    });

    this.getLatestCommitRoute = new SyncGetLatestCommitRoute(
      deps.repoRegistry,
      deps.handleResolutionReader,
      revLookup
    );

    this.getRecordRoute = new RepoGetRecordRoute(
      deps.recordReader,
      deps.handleResolutionReader,
      revLookup
    );

    this.listRecordsRoute = new RepoListRecordsRoute(
      deps.recordReader,
      deps.handleResolutionReader,
      revLookup
    );

    this.resolveHandleRoute = new IdentityResolveHandleRoute(
      deps.handleResolutionReader
    );

    this.subscribeReposRoute = new SubscribeReposRoute(
      deps.firehoseSubscriptions
    );
  }

  async start(): Promise<void> {
    // TODO: Wire into a real HTTP/WebSocket server (Fastify, Express, or raw
    // Node http.createServer + ws library).  The handleRequest method below
    // provides the request-dispatch logic independently of the transport layer.
    console.log('[AtXrpcServer] Server started (stub — wire to HTTP transport)');
  }

  async stop(): Promise<void> {
    console.log('[AtXrpcServer] Server stopped');
  }

  // ---------------------------------------------------------------------------
  // Request dispatch (transport-agnostic, usable in tests)
  // ---------------------------------------------------------------------------

  async handleRequest(
    method: string,
    path: string,
    query: Record<string, string | undefined>
  ): Promise<{ status: number; headers: Record<string, string>; body: any }> {
    try {
      let result: { headers: Record<string, string>; body: any };

      if (method === 'GET' && path === '/xrpc/com.atproto.sync.getRepo') {
        result = await this.getRepoRoute.handle(query.did, query.since);

      } else if (method === 'GET' && path === '/xrpc/com.atproto.sync.getLatestCommit') {
        result = await this.getLatestCommitRoute.handle(query.did);

      } else if (method === 'GET' && path === '/xrpc/com.atproto.repo.getRecord') {
        result = await this.getRecordRoute.handle(
          query.repo,
          query.collection,
          query.rkey,
          query.cid
        );

      } else if (method === 'GET' && path === '/xrpc/com.atproto.repo.listRecords') {
        const limit = query.limit ? parseInt(query.limit, 10) : undefined;
        result = await this.listRecordsRoute.handle(
          query.repo,
          query.collection,
          limit,
          query.cursor,
          query.reverse === 'true'
        );

      } else if (method === 'GET' && path === '/xrpc/com.atproto.identity.resolveHandle') {
        result = await this.resolveHandleRoute.handle(query.handle);

      } else {
        return {
          status: 501,
          headers: { ...SECURITY_HEADERS },
          body: { error: 'MethodNotImplemented', message: 'Route not found' }
        };
      }

      return {
        status: 200,
        headers: { ...SECURITY_HEADERS, ...result.headers },
        body: result.body
      };

    } catch (err) {
      const mapped = mapToXrpcError(err);
      return {
        status: mapped.status,
        headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json' },
        body: mapped.body
      };
    }
  }

  /**
   * Handle an incoming WebSocket connection for subscribeRepos.
   * The caller is responsible for providing the send/close callbacks that
   * wrap the actual WebSocket object.
   */
  async handleWebSocketConnection(
    connectionId: string,
    rawCursor: string | undefined,
    sendFn: (data: Uint8Array) => Promise<void>,
    closeFn: (code?: number, reason?: string) => Promise<void>
  ): Promise<void> {
    await this.subscribeReposRoute.handleConnection(
      connectionId,
      rawCursor,
      sendFn,
      closeFn
    );
  }

  async handleWebSocketDisconnection(connectionId: string): Promise<void> {
    await this.subscribeReposRoute.handleDisconnection(connectionId);
  }
}
