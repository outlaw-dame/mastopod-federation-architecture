/**
 * V6.5 Phase 7: AT XRPC Fastify Bridge
 *
 * Mounts all XRPC routes onto a Fastify instance.
 * Delegates all request handling to DefaultAtXrpcServer methods —
 * this module owns only the HTTP transport binding.
 *
 * Route categories:
 *   Unauthenticated GET/WS  → xrpcServer.handleRequest()
 *   Session creation (POST) → xrpcServer.handleCreateSession()
 *   Session refresh  (POST) → xrpcServer.handleRefreshSession()
 *   Authenticated writes    → extract Bearer token
 *                             → sessionService.verifyAccessToken()
 *                             → xrpcServer.handleAuthenticatedRequest()
 *
 * WebSocket (subscribeRepos) is handled via raw 'upgrade' events on the
 * underlying Node HTTP server, not via @fastify/websocket, since the
 * project uses the plain `ws` package.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import type { DefaultAtXrpcServer } from './AtXrpcServer.js';
import type { AtSessionService } from '../auth/AtSessionTypes.js';
import type { OAuthAccessTokenVerifier } from '../oauth/OAuthTokenVerifier.js';

// ---------------------------------------------------------------------------
// Bridge options
// ---------------------------------------------------------------------------

export interface AtXrpcFastifyBridgeOptions {
  /**
   * The XRPC server that owns all route handling logic.
   */
  xrpcServer: DefaultAtXrpcServer;

  /**
   * Required for authenticated write routes.
   * When omitted, write endpoints return 501 (consistent with the XRPC
   * server's own behaviour when writeGateway is not configured).
   */
  sessionService?: AtSessionService;

  /**
   * Optional OAuth verifier for DPoP-bound access tokens.
   * When provided, write endpoints accept ATProto OAuth DPoP Bearer tokens.
   */
  oauthTokenVerifier?: OAuthAccessTokenVerifier;

  /**
   * Prefix for all XRPC routes.  Defaults to '/xrpc'.
   */
  prefix?: string;
}

// ---------------------------------------------------------------------------
// Authenticated XRPC POST routes
// ---------------------------------------------------------------------------

const AUTHENTICATED_POST_ROUTES = new Set([
  '/xrpc/com.atproto.repo.createRecord',
  '/xrpc/com.atproto.repo.putRecord',
  '/xrpc/com.atproto.repo.deleteRecord',
]);

// ---------------------------------------------------------------------------
// Bridge registration
// ---------------------------------------------------------------------------

/**
 * Register all XRPC routes on the given Fastify instance.
 * Call this AFTER `app.listen()` returns if you also need WebSocket support,
 * because `app.server` is only populated post-listen.
 */
export function registerAtXrpcRoutes(
  app: FastifyInstance,
  opts: AtXrpcFastifyBridgeOptions
): void {
  const { xrpcServer, sessionService, oauthTokenVerifier } = opts;

  // ---- Unauthenticated GET routes ----------------------------------------

 const getRoutes: string[] = [
    '/xrpc/com.atproto.sync.getRepo',
    '/xrpc/com.atproto.sync.getLatestCommit',
    // Public immutable blob reads used by profile/avatar and media projection.
    '/xrpc/com.atproto.sync.getBlob',
    '/xrpc/com.atproto.repo.getRecord',
    '/xrpc/com.atproto.repo.listRecords',
    '/xrpc/com.atproto.identity.resolveHandle',
    '/xrpc/com.atproto.server.describeServer',
    '/xrpc/com.atproto.repo.describeRepo',
  ];

  for (const route of getRoutes) {
    app.get(route, async (req: FastifyRequest, reply: FastifyReply) => {
      const query = Object.fromEntries(
        Object.entries(req.query as Record<string, unknown>).map(([k, v]) => [
          k,
          typeof v === 'string' ? v : undefined,
        ])
      );

      const result = await xrpcServer.handleRequest(
        'GET',
        req.url.split('?')[0] ?? req.url,
        query,
        req.ip
      );

      return reply
        .status(result.status)
        .headers(result.headers)
        .send(result.body);
    });
  }

  // ---- Session creation (unauthenticated POST) ----------------------------

  app.post(
    '/xrpc/com.atproto.server.createSession',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body as Record<string, unknown> | undefined);

      const result = await xrpcServer.handleCreateSession(body);

      return reply
        .status(result.status)
        .headers(result.headers)
        .send(result.body);
    }
  );

  app.post(
    '/xrpc/com.atproto.server.refreshSession',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const result = await xrpcServer.handleRefreshSession(
        (req.headers.authorization as string | undefined) ?? undefined
      );

      return reply
        .status(result.status)
        .headers(result.headers)
        .send(result.body);
    }
  );

  // ---- Authenticated write routes ----------------------------------------

  for (const route of AUTHENTICATED_POST_ROUTES) {
    app.post(route, async (req: FastifyRequest, reply: FastifyReply) => {
      const authHeader = (req.headers.authorization as string | undefined) ?? '';
      const dpopHeader =
        typeof req.headers["dpop"] === 'string'
          ? req.headers["dpop"]
          : undefined;

      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

      if (!token) {
        return reply.status(401).send({
          error: 'AuthRequired',
          message: 'Authorization header with Bearer token is required',
        });
      }

      let sessionCtx = null;

      if (oauthTokenVerifier) {
        const host = req.headers.host ?? 'localhost';
        const htu = `${req.protocol}://${host}${req.url.split('?')[0]}`;
        const oauthResult = await oauthTokenVerifier.verify(
          authHeader,
          dpopHeader,
          'POST',
          htu,
        );

        if (oauthResult.errorCode === 'use_dpop_nonce') {
          if (oauthResult.nonce) {
            reply.header('DPoP-Nonce', oauthResult.nonce);
          }
          return reply.status(401).send({
            error: 'AuthRequired',
            message: 'DPoP nonce required',
          });
        }

        if (oauthResult.session) {
          sessionCtx = oauthResult.session;
        }
      }

      if (!sessionCtx && !sessionService) {
        return reply.status(501).send({
          error: 'MethodNotImplemented',
          message: 'No auth verifier configured',
        });
      }

      if (!sessionCtx && sessionService) {
        sessionCtx = await sessionService.verifyAccessToken(token);
      }

      if (!sessionCtx) {
        return reply.status(401).send({
          error: 'AuthRequired',
          message: 'Invalid or expired access token',
        });
      }

      const body = typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body as Record<string, unknown> | undefined);

      const result = await xrpcServer.handleAuthenticatedRequest(
        'POST',
        req.url.split('?')[0] ?? req.url,
        body,
        sessionCtx
      );

      return reply
        .status(result.status)
        .headers(result.headers)
        .send(result.body);
    });
  }
}

// ---------------------------------------------------------------------------
// WebSocket: subscribeRepos
// ---------------------------------------------------------------------------

/**
 * Attach a WebSocket server for com.atproto.sync.subscribeRepos to the
 * Node.js HTTP server underlying Fastify.
 *
 * Must be called AFTER `await app.listen(...)` because `app.server` is
 * populated only at that point.
 *
 * The subscribeRepos path is `/xrpc/com.atproto.sync.subscribeRepos`.
 * The optional `cursor` query parameter is extracted and forwarded.
 */
export function attachSubscribeReposWebSocket(
  app: FastifyInstance,
  xrpcServer: DefaultAtXrpcServer
): void {
  const SUBSCRIBE_REPOS_PATH = '/xrpc/com.atproto.sync.subscribeRepos';

  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname !== SUBSCRIBE_REPOS_PATH) return;

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const connectionId = `ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const rawCursor = url.searchParams.get('cursor') ?? undefined;

      xrpcServer
        .handleWebSocketConnection(
          connectionId,
          rawCursor,
          async (data) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(data);
            }
          },
          async (code, reason) => {
            if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
              ws.close(code ?? 1000, reason);
            }
          }
        )
        .catch((err: unknown) => {
          console.error('[subscribeRepos] Connection handler error:', err);
          ws.close(1011, 'Internal server error');
        });

      ws.on('close', () => {
        xrpcServer.handleWebSocketDisconnection(connectionId).catch((err: unknown) => {
          console.error('[subscribeRepos] Disconnection handler error:', err);
        });
      });
    });
  });
}
