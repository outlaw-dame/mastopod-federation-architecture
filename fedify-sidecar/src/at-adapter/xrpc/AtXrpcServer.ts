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
import type { IdentityBindingRepository } from '../../core-domain/identity/IdentityBindingRepository';
import { SyncGetRepoRoute } from './routes/SyncGetRepoRoute';
import { SyncGetLatestCommitRoute } from './routes/SyncGetLatestCommitRoute';
import { RepoGetRecordRoute } from './routes/RepoGetRecordRoute';
import { RepoListRecordsRoute } from './routes/RepoListRecordsRoute';
import { IdentityResolveHandleRoute } from './routes/IdentityResolveHandleRoute';
import { SubscribeReposRoute } from './routes/SubscribeReposRoute';
import { DefaultRepoRevLookup } from './middleware/AtRepoRevHeader';
import { mapToXrpcError, XrpcErrors } from './middleware/XrpcErrorMapper';
// Phase 7: authenticated write + session routes
import {
  ServerDescribeServerRoute,
  type ServerDescribeServerConfig,
} from './routes/ServerDescribeServerRoute';
import { ServerCreateSessionRoute } from './routes/ServerCreateSessionRoute';
import { ServerRefreshSessionRoute } from './routes/ServerRefreshSessionRoute';
import { RepoCreateRecordRoute } from './routes/RepoCreateRecordRoute';
import { RepoPutRecordRoute } from './routes/RepoPutRecordRoute';
import { RepoDeleteRecordRoute } from './routes/RepoDeleteRecordRoute';
import { RepoDescribeRepoRoute } from './routes/RepoDescribeRepoRoute';
import type { AtSessionService, AtAccountResolver, AtPasswordVerifier } from '../auth/AtSessionTypes';
import type { AtWriteGateway } from '../writes/AtWriteTypes';
import type { AtSessionContext } from '../auth/AtSessionTypes';
import type { ExternalWriteGateway } from '../external/ExternalWriteGateway.js';
import type { ExternalReadGateway } from '../external/ExternalReadGateway.js';

// ---------------------------------------------------------------------------
// Dependency injection interface
// ---------------------------------------------------------------------------

export interface AtXrpcServerDeps {
  recordReader: AtRecordReader;
  carExporter: AtCarExporter;
  handleResolutionReader: HandleResolutionReader;
  firehoseSubscriptions: AtFirehoseSubscriptionManager;
  repoRegistry: AtprotoRepoRegistry;
  /** Optional: enables handleIsCorrect round-trip in describeRepo */
  identityRepo?: IdentityBindingRepository;
  // Phase 7: write + session deps (optional — omit to disable write endpoints)
  serverConfig?: ServerDescribeServerConfig;
  sessionService?: AtSessionService;
  accountResolver?: AtAccountResolver;
  passwordVerifier?: AtPasswordVerifier;
  writeGateway?: AtWriteGateway;
  externalWriteGateway?: ExternalWriteGateway;
  externalReadGateway?: ExternalReadGateway;
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
  // Phase 7 routes (null when Phase 7 deps not provided)
  private readonly describeServerRoute: ServerDescribeServerRoute | null;
  private readonly createSessionRoute: ServerCreateSessionRoute | null;
  private readonly refreshSessionRoute: ServerRefreshSessionRoute | null;
  private readonly createRecordRoute: RepoCreateRecordRoute | null;
  private readonly putRecordRoute: RepoPutRecordRoute | null;
  private readonly deleteRecordRoute: RepoDeleteRecordRoute | null;
  private readonly describeRepoRoute: RepoDescribeRepoRoute | null;

  constructor(private readonly deps: AtXrpcServerDeps) {
    const revLookup = new DefaultRepoRevLookup(deps.repoRegistry);

    this.getRepoRoute = new SyncGetRepoRoute({
      carExporter: deps.carExporter,
      handleResolutionReader: deps.handleResolutionReader,
      repoRegistry: deps.repoRegistry,
      identityRepo: deps.identityRepo,
      externalReadGateway: deps.externalReadGateway,
    });

    this.getLatestCommitRoute = new SyncGetLatestCommitRoute(
      deps.repoRegistry,
      deps.handleResolutionReader,
      revLookup,
      deps.identityRepo,
      deps.externalReadGateway
    );

    this.getRecordRoute = new RepoGetRecordRoute(
      deps.recordReader,
      deps.handleResolutionReader,
      revLookup,
      deps.identityRepo,
      deps.externalReadGateway
    );

    this.listRecordsRoute = new RepoListRecordsRoute(
      deps.recordReader,
      deps.handleResolutionReader,
      revLookup,
      deps.identityRepo,
      deps.externalReadGateway
    );

    this.resolveHandleRoute = new IdentityResolveHandleRoute(
      deps.handleResolutionReader
    );

    this.subscribeReposRoute = new SubscribeReposRoute(
      deps.firehoseSubscriptions
    );

    // Phase 7: wire write/session routes when all deps are present
    this.describeServerRoute = deps.serverConfig
      ? new ServerDescribeServerRoute(deps.serverConfig)
      : null;

    this.createSessionRoute =
      deps.sessionService
        ? new ServerCreateSessionRoute(deps.sessionService)
        : null;

    this.refreshSessionRoute =
      deps.sessionService
        ? new ServerRefreshSessionRoute(deps.sessionService)
        : null;

    this.createRecordRoute = deps.writeGateway
      ? new RepoCreateRecordRoute(
          deps.writeGateway,
          deps.identityRepo,
          deps.externalWriteGateway
        )
      : null;

    this.putRecordRoute = deps.writeGateway
      ? new RepoPutRecordRoute(
          deps.writeGateway,
          deps.identityRepo,
          deps.externalWriteGateway
        )
      : null;

    this.deleteRecordRoute = deps.writeGateway
      ? new RepoDeleteRecordRoute(
          deps.writeGateway,
          deps.identityRepo,
          deps.externalWriteGateway
        )
      : null;

    this.describeRepoRoute = new RepoDescribeRepoRoute(
      deps.repoRegistry,
      deps.handleResolutionReader,
      deps.identityRepo,
      deps.externalReadGateway,
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
    query: Record<string, string | undefined>,
    clientIp?: string
  ): Promise<{ status: number; headers: Record<string, string>; body: any }> {
    try {
      // TODO (Phase 5): Implement rate limiting middleware here.
      // E.g., check rateLimitStore.increment(clientIp, path)
      // If exceeded, throw XrpcErrors.rateLimitExceeded()
      
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

      } else if (method === 'GET' && path === '/xrpc/com.atproto.server.describeServer') {
        if (!this.describeServerRoute) {
          return { status: 501, headers: { ...SECURITY_HEADERS }, body: { error: 'MethodNotImplemented', message: 'describeServer not configured' } };
        }
        result = await this.describeServerRoute.handle();

      } else if (method === 'GET' && path === '/xrpc/com.atproto.repo.describeRepo') {
        result = await this.describeRepoRoute!.handle(query.repo);

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

  // ---------------------------------------------------------------------------
  // Phase 7: Authenticated request dispatch
  // Caller is responsible for extracting the bearer token and resolving the
  // AtSessionContext before calling this method.
  // ---------------------------------------------------------------------------

  async handleAuthenticatedRequest(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    auth: AtSessionContext
  ): Promise<{ status: number; headers: Record<string, string>; body: any }> {
    try {
      let result: { headers: Record<string, string>; body: any };

      if (method === 'POST' && path === '/xrpc/com.atproto.repo.createRecord') {
        if (!this.createRecordRoute) {
          return { status: 501, headers: { ...SECURITY_HEADERS }, body: { error: 'MethodNotImplemented', message: 'Write endpoints not configured' } };
        }
        result = await this.createRecordRoute.handle(body, auth);

      } else if (method === 'POST' && path === '/xrpc/com.atproto.repo.putRecord') {
        if (!this.putRecordRoute) {
          return { status: 501, headers: { ...SECURITY_HEADERS }, body: { error: 'MethodNotImplemented', message: 'Write endpoints not configured' } };
        }
        result = await this.putRecordRoute.handle(body, auth);

      } else if (method === 'POST' && path === '/xrpc/com.atproto.repo.deleteRecord') {
        if (!this.deleteRecordRoute) {
          return { status: 501, headers: { ...SECURITY_HEADERS }, body: { error: 'MethodNotImplemented', message: 'Write endpoints not configured' } };
        }
        result = await this.deleteRecordRoute.handle(body, auth);

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

  // ---------------------------------------------------------------------------
  // Phase 7: Unauthenticated session creation (special case: no auth token yet)
  // ---------------------------------------------------------------------------

  async handleCreateSession(
    body: Record<string, unknown> | undefined
  ): Promise<{ status: number; headers: Record<string, string>; body: any }> {
    try {
      if (!this.createSessionRoute) {
        return {
          status: 501,
          headers: { ...SECURITY_HEADERS },
          body: { error: 'MethodNotImplemented', message: 'Session endpoints not configured' }
        };
      }
      const result = await this.createSessionRoute.handle(body);
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

  async handleRefreshSession(
    authorizationHeader: string | undefined
  ): Promise<{ status: number; headers: Record<string, string>; body: any }> {
    try {
      if (!this.refreshSessionRoute) {
        return {
          status: 501,
          headers: { ...SECURITY_HEADERS },
          body: { error: 'MethodNotImplemented', message: 'Session endpoints not configured' }
        };
      }
      const result = await this.refreshSessionRoute.handle(authorizationHeader);
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
