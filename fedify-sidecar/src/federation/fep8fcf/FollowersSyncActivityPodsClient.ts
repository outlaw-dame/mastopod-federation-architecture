/**
 * FEP-8fcf: ActivityPods internal API client for followers synchronization.
 *
 * Calls three new ActivityPods internal endpoints.  All calls degrade
 * gracefully to empty/false results when the endpoint returns 404 or 501,
 * allowing the sidecar to run against an older ActivityPods that has not yet
 * implemented these routes — followers sync is OPTIONAL per FEP-8fcf.
 *
 * Expected ActivityPods endpoints (add to activity-pods pod-provider):
 *
 *   GET  /api/internal/followers-sync/partial-collection
 *          ?actorIdentifier={id}&domain={domain}
 *        → { followers: string[] }
 *        Returns URIs of followers of the local actor whose id origin matches
 *        the requested domain.  Used by the sender to compute the digest and
 *        to serve the /followers_synchronization endpoint.
 *
 *   GET  /api/internal/followers-sync/local-followers-of-remote
 *          ?remoteActorUri={encoded}
 *        → { localActors: Array<{ actorUri: string; identifier: string }> }
 *        Returns local actors that currently follow the given remote actor.
 *        Used by the receiver to compute its local partial digest.
 *
 *   POST /api/internal/followers-sync/unfollow
 *        Body: { localActorIdentifier: string; remoteActorUri: string }
 *        → 200 OK
 *        Removes a local actor's follow of a remote actor without sending an
 *        Undo Follow activity (the sidecar handles that separately).
 */

import { request } from "undici";
import { logger } from "../../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface FollowersSyncApClientConfig {
  activityPodsUrl: string;
  activityPodsToken: string;
  requestTimeoutMs?: number;
}

export interface LocalActorFollowerRecord {
  /** Full URI of the local actor, e.g. "https://our.example.com/users/alice" */
  actorUri: string;
  /** Local identifier used in API paths, e.g. "alice" */
  identifier: string;
}

// ============================================================================
// Client
// ============================================================================

export class FollowersSyncActivityPodsClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: FollowersSyncApClientConfig) {
    this.baseUrl = config.activityPodsUrl.replace(/\/$/, "");
    this.token = config.activityPodsToken;
    this.timeoutMs = config.requestTimeoutMs ?? 10_000;
  }

  // --------------------------------------------------------------------------
  // getPartialFollowers
  // --------------------------------------------------------------------------

  /**
   * Return the URIs of followers of a local actor whose origin matches
   * `domain`.
   *
   * Returns `[]` if the endpoint is unavailable (404 / 501) or on any error.
   */
  async getPartialFollowers(actorIdentifier: string, domain: string): Promise<string[]> {
    const url =
      `${this.baseUrl}/api/internal/followers-sync/partial-collection` +
      `?actorIdentifier=${encodeURIComponent(actorIdentifier)}` +
      `&domain=${encodeURIComponent(domain)}`;

    try {
      const resp = await request(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
        },
        bodyTimeout: this.timeoutMs,
        headersTimeout: this.timeoutMs,
      });

      if (resp.statusCode === 404 || resp.statusCode === 501) {
        await resp.body.text();
        return [];
      }

      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        await resp.body.text();
        logger.warn("[fep8fcf] getPartialFollowers: unexpected status", {
          actorIdentifier,
          domain,
          status: resp.statusCode,
        });
        return [];
      }

      const body = await resp.body.json() as { followers?: unknown };
      if (!Array.isArray(body.followers)) return [];
      return body.followers.filter((f): f is string => typeof f === "string");
    } catch (err: any) {
      logger.warn("[fep8fcf] getPartialFollowers: request error", {
        actorIdentifier,
        domain,
        error: err.message,
      });
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // getLocalFollowersOfRemote
  // --------------------------------------------------------------------------

  /**
   * Return local actors that currently follow the given remote actor URI.
   *
   * Returns `[]` if the endpoint is unavailable or on any error.
   */
  async getLocalFollowersOfRemote(remoteActorUri: string): Promise<LocalActorFollowerRecord[]> {
    const url =
      `${this.baseUrl}/api/internal/followers-sync/local-followers-of-remote` +
      `?remoteActorUri=${encodeURIComponent(remoteActorUri)}`;

    try {
      const resp = await request(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
        },
        bodyTimeout: this.timeoutMs,
        headersTimeout: this.timeoutMs,
      });

      if (resp.statusCode === 404 || resp.statusCode === 501) {
        await resp.body.text();
        return [];
      }

      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        await resp.body.text();
        logger.warn("[fep8fcf] getLocalFollowersOfRemote: unexpected status", {
          remoteActorUri,
          status: resp.statusCode,
        });
        return [];
      }

      const body = await resp.body.json() as { localActors?: unknown };
      if (!Array.isArray(body.localActors)) return [];
      return body.localActors.filter(
        (a): a is LocalActorFollowerRecord =>
          typeof a === "object" &&
          a !== null &&
          typeof (a as Record<string, unknown>)["actorUri"] === "string" &&
          typeof (a as Record<string, unknown>)["identifier"] === "string",
      );
    } catch (err: any) {
      logger.warn("[fep8fcf] getLocalFollowersOfRemote: request error", {
        remoteActorUri,
        error: err.message,
      });
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // removeLocalFollow
  // --------------------------------------------------------------------------

  /**
   * Remove a local actor's follow of a remote actor.
   *
   * Returns `true` on 2xx; `false` if unavailable (404 / 501) or on any error.
   */
  async removeLocalFollow(
    localActorIdentifier: string,
    remoteActorUri: string,
  ): Promise<boolean> {
    try {
      const resp = await request(
        `${this.baseUrl}/api/internal/followers-sync/unfollow`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ localActorIdentifier, remoteActorUri }),
          bodyTimeout: this.timeoutMs,
          headersTimeout: this.timeoutMs,
        },
      );

      if (resp.statusCode === 404 || resp.statusCode === 501) {
        await resp.body.text();
        return false;
      }

      await resp.body.text();
      return resp.statusCode >= 200 && resp.statusCode < 300;
    } catch (err: any) {
      logger.warn("[fep8fcf] removeLocalFollow: request error", {
        localActorIdentifier,
        remoteActorUri,
        error: err.message,
      });
      return false;
    }
  }
}
