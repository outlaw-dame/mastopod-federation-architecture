/**
 * ActivityPods Client
 * 
 * Handles communication with the ActivityPods backend for:
 * - Fetching actor data
 * - Forwarding inbox activities
 * - Requesting signatures
 */

import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";
import { getAttributionDomains } from "../utils/authorAttribution.js";

export interface ActorData {
  id: string;
  type: string;
  preferredUsername: string;
  name?: string;
  summary?: string;
  url?: string;
  inbox: string;
  outbox: string;
  followers?: string;
  following?: string;
  publicKey?: {
    id: string;
    owner: string;
    publicKeyPem: string;
  };
  icon?: {
    type: string;
    url: string;
    mediaType?: string;
  };
  image?: {
    type: string;
    url: string;
    mediaType?: string;
  };
  indexable?: boolean;
  searchableBy?: string | string[];
  attributionDomains?: string[];
  status?: Record<string, unknown>;
  statusHistory?: unknown;
}

export interface KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export class ActivityPodsClient {
  private baseUrl: string;
  private actorCache = new Map<string, { data: ActorData; expiry: number }>();
  private readonly cacheTtlMs = 300000; // 5 minutes

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Get actor data by handle
   */
  async getActor(handle: string): Promise<ActorData | null> {
    // Check cache
    const cached = this.actorCache.get(handle);
    if (cached && cached.expiry > Date.now()) {
      return cached.data;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/api/actors/${encodeURIComponent(handle)}`,
        {
          headers: {
            Accept: "application/ld+json, application/activity+json",
            "X-Internal-Request": "true",
            ...(config.activitypods.internalApiKey && {
              "X-API-Key": config.activitypods.internalApiKey,
            }),
          },
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Failed to fetch actor: ${response.status}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const actorData = this.mapToActorData(data);

      // Cache the result
      this.actorCache.set(handle, {
        data: actorData,
        expiry: Date.now() + this.cacheTtlMs,
      });

      return actorData;
    } catch (error) {
      logger.error("Failed to fetch actor from ActivityPods", { handle, error });
      throw error;
    }
  }

  /**
   * Get actor by full URI
   */
  async getActorByUri(uri: string): Promise<ActorData | null> {
    try {
      const response = await fetch(uri, {
        headers: {
          Accept: "application/ld+json, application/activity+json",
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Failed to fetch actor: ${response.status}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      return this.mapToActorData(data);
    } catch (error) {
      logger.error("Failed to fetch actor by URI", { uri, error });
      throw error;
    }
  }

  /**
   * Get actor key pair for signing
   */
  async getActorKeyPair(handle: string): Promise<KeyPair | null> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/actors/${encodeURIComponent(handle)}/keys`,
        {
          headers: {
            "X-Internal-Request": "true",
            ...(config.activitypods.internalApiKey && {
              "X-API-Key": config.activitypods.internalApiKey,
            }),
          },
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Failed to fetch key pair: ${response.status}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const publicKeyPem = data["publicKeyPem"];
      const privateKeyPem = data["privateKeyPem"];
      if (typeof publicKeyPem !== "string" || typeof privateKeyPem !== "string") {
        throw new Error("ActivityPods key response missing PEM material");
      }

      // Import the keys
      const publicKey = await crypto.subtle.importKey(
        "spki",
        this.pemToArrayBuffer(publicKeyPem),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        true,
        ["verify"]
      );

      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        this.pemToArrayBuffer(privateKeyPem),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        true,
        ["sign"]
      );

      return { publicKey, privateKey };
    } catch (error) {
      logger.error("Failed to fetch key pair from ActivityPods", { handle, error });
      throw error;
    }
  }

  /**
   * Forward an inbox activity to ActivityPods
   */
  async forwardInboxActivity(activity: unknown): Promise<void> {
    const act = activity as Record<string, unknown>;
    
    try {
      const response = await fetch(
        `${this.baseUrl}/api/inbox/forward`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/ld+json",
            "X-Internal-Request": "true",
            "X-Signature-Verified": "true", // Sidecar has already verified
            ...(config.activitypods.internalApiKey && {
              "X-API-Key": config.activitypods.internalApiKey,
            }),
          },
          body: JSON.stringify(activity),
        }
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Failed to forward activity: ${response.status} ${body}`);
      }

      logger.debug("Activity forwarded to ActivityPods", {
        id: act["id"] ?? act["@id"],
        type: act["type"] ?? act["@type"],
      });
    } catch (error) {
      logger.error("Failed to forward inbox activity", { error });
      throw error;
    }
  }

  /**
   * Request a signature from ActivityPods
   */
  async requestSignature(
    actorId: string,
    signingString: string
  ): Promise<string> {
    try {
      const response = await fetch(
        `${this.baseUrl}/api/signing/sign`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Request": "true",
            ...(config.activitypods.internalApiKey && {
              "X-API-Key": config.activitypods.internalApiKey,
            }),
          },
          body: JSON.stringify({
            actorId,
            signingString,
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to request signature: ${response.status}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const signature = data["signature"];
      if (typeof signature !== "string") {
        throw new Error("ActivityPods signing response missing signature");
      }
      return signature;
    } catch (error) {
      logger.error("Failed to request signature from ActivityPods", { actorId, error });
      throw error;
    }
  }

  /**
   * Map raw JSON-LD to ActorData
   */
  private mapToActorData(data: Record<string, unknown>): ActorData {
    return {
      id: (data["id"] ?? data["@id"]) as string,
      type: (data["type"] ?? data["@type"] ?? "Person") as string,
      preferredUsername: data["preferredUsername"] as string,
      name: data["name"] as string | undefined,
      summary: data["summary"] as string | undefined,
      url: data["url"] as string | undefined,
      inbox: data["inbox"] as string,
      outbox: data["outbox"] as string,
      followers: data["followers"] as string | undefined,
      following: data["following"] as string | undefined,
      publicKey: data["publicKey"] as ActorData["publicKey"],
      icon: data["icon"] as ActorData["icon"],
      image: data["image"] as ActorData["image"],
      indexable: typeof data["indexable"] === "boolean" ? (data["indexable"] as boolean) : undefined,
      searchableBy:
        typeof data["searchableBy"] === "string" || Array.isArray(data["searchableBy"])
          ? (data["searchableBy"] as string | string[])
          : undefined,
      attributionDomains: getAttributionDomains(data),
      status: (data["status"] && typeof data["status"] === "object" && !Array.isArray(data["status"]))
        ? (data["status"] as Record<string, unknown>)
        : undefined,
      statusHistory: data["statusHistory"],
    };
  }

  /**
   * Convert PEM string to ArrayBuffer
   */
  private pemToArrayBuffer(pem: string): ArrayBuffer {
    const base64 = pem
      .replace(/-----BEGIN [A-Z ]+-----/, "")
      .replace(/-----END [A-Z ]+-----/, "")
      .replace(/\s/g, "");
    
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    
    return bytes.buffer;
  }

  /**
   * Clear the actor cache
   */
  clearCache(): void {
    this.actorCache.clear();
  }
}
