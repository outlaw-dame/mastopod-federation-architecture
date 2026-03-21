/**
 * Signing Service
 * 
 * Handles HTTP signature generation by calling the ActivityPods signing API.
 * Implements caching to avoid redundant signature operations.
 */

import { createHash } from "crypto";
import { logger } from "../utils/logger.js";
import { metrics } from "../metrics/index.js";

interface CachedSignature {
  signature: string;
  expiry: number;
}

export class SigningService {
  private signingApiUrl: string;
  private cache = new Map<string, CachedSignature>();
  private readonly cacheTtlMs: number;

  constructor(signingApiUrl: string, cacheTtlMs: number = 300000) {
    this.signingApiUrl = signingApiUrl;
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Generate HTTP signature for a request
   */
  async sign(
    actorId: string,
    method: string,
    targetUrl: string,
    body?: string
  ): Promise<{
    signature: string;
    date: string;
    digest?: string;
  }> {
    const startTime = Date.now();
    const url = new URL(targetUrl);
    const date = new Date().toUTCString();
    
    // Compute digest if body is provided
    const digest = body ? this.computeDigest(body) : undefined;

    // Build the signing string
    const signingString = this.buildSigningString(method, url, date, digest);

    // Check cache
    const cacheKey = `${actorId}:${signingString}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && cached.expiry > Date.now()) {
      metrics.signatureCacheHits.inc();
      return {
        signature: cached.signature,
        date,
        digest,
      };
    }

    metrics.signatureCacheMisses.inc();

    // Request signature from ActivityPods
    const signatureValue = await this.requestSignature(actorId, signingString);

    // Build the full Signature header
    const keyId = `${actorId}#main-key`;
    const headers = digest
      ? "(request-target) host date digest"
      : "(request-target) host date";
    
    const signature = `keyId="${keyId}",algorithm="rsa-sha256",headers="${headers}",signature="${signatureValue}"`;

    // Cache the result
    this.cache.set(cacheKey, {
      signature,
      expiry: Date.now() + this.cacheTtlMs,
    });

    const duration = Date.now() - startTime;
    metrics.signatureGenerationLatency.observe(duration / 1000);

    return {
      signature,
      date,
      digest,
    };
  }

  /**
   * Build the signing string according to HTTP Signatures spec
   */
  private buildSigningString(
    method: string,
    url: URL,
    date: string,
    digest?: string
  ): string {
    const lines = [
      `(request-target): ${method.toLowerCase()} ${url.pathname}`,
      `host: ${url.host}`,
      `date: ${date}`,
    ];

    if (digest) {
      lines.push(`digest: ${digest}`);
    }

    return lines.join("\n");
  }

  /**
   * Compute SHA-256 digest of body
   */
  private computeDigest(body: string): string {
    const hash = createHash("sha256").update(body).digest("base64");
    return `SHA-256=${hash}`;
  }

  /**
   * Request signature from ActivityPods signing API
   */
  private async requestSignature(
    actorId: string,
    signingString: string
  ): Promise<string> {
    try {
      const response = await fetch(this.signingApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Request": "true",
        },
        body: JSON.stringify({
          actorId,
          signingString,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Signing API error: ${response.status} ${body}`);
      }

      const data = await response.json() as { signature: string };
      return data.signature;
    } catch (error) {
      logger.error("Failed to request signature", { actorId, error });
      throw error;
    }
  }

  /**
   * Clear the signature cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; hitRate: number } {
    const hits = metrics.signatureCacheHits as any;
    const misses = metrics.signatureCacheMisses as any;
    
    const totalHits = hits?.hashMap?.values?.()?.next?.()?.value ?? 0;
    const totalMisses = misses?.hashMap?.values?.()?.next?.()?.value ?? 0;
    const total = totalHits + totalMisses;

    return {
      size: this.cache.size,
      hitRate: total > 0 ? totalHits / total : 0,
    };
  }
}
