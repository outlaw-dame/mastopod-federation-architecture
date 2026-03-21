/**
 * Signing Client for ActivityPods Signing API
 * 
 * This client calls the ActivityPods signing service to get HTTP signatures
 * for outbound federation requests. Keys NEVER leave ActivityPods.
 * 
 * Contract:
 * - POST /api/internal/signatures/batch
 * - Batch requests by actorUri for efficiency (key reuse on server)
 * - Handle error codes properly (permanent vs retryable)
 * - Body is signed as-is (immutable bytes)
 */

import { request } from "undici";
import { logger } from "../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export type SignProfile = "ap_get_v1" | "ap_post_v1" | "ap_post_v1_ct";

export interface SignRequest {
  requestId: string;
  actorUri: string;
  method: "POST" | "GET";
  targetUrl: string;
  headers: Record<string, string>;
  body?: string;  // Raw body bytes - immutable, will be signed as-is
  options?: {
    requireDigest?: boolean;
    signatureHeaders?: string[];
  };
}

export interface SignBatchRequest {
  requests: SignRequest[];
}

export interface SignSuccessResult {
  requestId: string;
  ok: true;
  signedHeaders: {
    date: string;
    digest?: string;
    signature: string;
  };
  meta?: {
    keyId: string;
    algorithm: string;
    signedHeadersList: string[];
  };
}

export interface SignErrorResult {
  requestId: string;
  ok: false;
  error: {
    code: SigningErrorCode;
    message: string;
  };
}

export type SignResult = SignSuccessResult | SignErrorResult;

export interface SignBatchResponse {
  results: SignResult[];
}

// Error codes from the Signing API contract
export type SigningErrorCode =
  | "ACTOR_NOT_LOCAL"    // Actor not controlled by this server
  | "ACTOR_NOT_FOUND"    // Actor deleted or doesn't exist
  | "KEY_NOT_FOUND"      // No key material for actor
  | "AUTH_FAILED"        // Sidecar not authorized
  | "INVALID_REQUEST"    // Malformed request
  | "BODY_TOO_LARGE"     // Activity exceeds size limit
  | "RATE_LIMITED"       // Too many requests, back off
  | "INTERNAL_ERROR";    // Transient server error

// Permanent errors - should NOT retry delivery
const PERMANENT_ERRORS: SigningErrorCode[] = [
  "ACTOR_NOT_LOCAL",
  "ACTOR_NOT_FOUND",
  "KEY_NOT_FOUND",
  "AUTH_FAILED",
  "INVALID_REQUEST",
  "BODY_TOO_LARGE",
];

// Retryable errors - can retry delivery
const RETRYABLE_ERRORS: SigningErrorCode[] = [
  "RATE_LIMITED",
  "INTERNAL_ERROR",
];

export interface SigningClientConfig {
  baseUrl: string;
  token: string;
  maxBatchSize: number;
  maxBodyBytes: number;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

// ============================================================================
// Signing Client
// ============================================================================

export class SigningClient {
  private config: SigningClientConfig;

  constructor(config: SigningClientConfig) {
    this.config = config;
  }

  /**
   * Sign a batch of HTTP requests.
   * 
   * @param requests - The signing requests
   * @returns The signing results (one per request)
   */
  async signBatch(requests: SignRequest[]): Promise<SignResult[]> {
    // Pre-validate body sizes
    for (const req of requests) {
      if (req.body && req.body.length > this.config.maxBodyBytes) {
        logger.warn("Body too large for signing", {
          requestId: req.requestId,
          size: req.body.length,
          max: this.config.maxBodyBytes,
        });
        // Return error for this request, but continue with others
      }
    }

    // Split into batches if needed
    const allResults: SignResult[] = [];
    
    for (let i = 0; i < requests.length; i += this.config.maxBatchSize) {
      const batch = requests.slice(i, i + this.config.maxBatchSize);
      const results = await this.signBatchInternal(batch);
      allResults.push(...results);
    }

    return allResults;
  }

  private async signBatchInternal(requests: SignRequest[]): Promise<SignResult[]> {
    const url = `${this.config.baseUrl}/api/internal/signatures/batch`;
    
    logger.debug("Calling signing API", {
      url,
      requestCount: requests.length,
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const res = await request(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${this.config.token}`,
          },
          body: JSON.stringify({ requests }),
          bodyTimeout: this.config.timeoutMs,
          headersTimeout: this.config.timeoutMs,
        });

        // Handle auth errors (permanent)
        if (res.statusCode === 401 || res.statusCode === 403) {
          const text = await res.body.text();
          logger.error("Signing API auth failed", { status: res.statusCode, body: text });
          return requests.map(r => ({
            requestId: r.requestId,
            ok: false as const,
            error: {
              code: "AUTH_FAILED" as SigningErrorCode,
              message: `Authentication failed: ${res.statusCode}`,
            },
          }));
        }

        // Handle rate limiting (retryable)
        if (res.statusCode === 429) {
          const retryAfter = parseInt(res.headers["retry-after"] as string || "5", 10);
          logger.warn("Signing API rate limited", { retryAfter, attempt });
          await this.sleep(retryAfter * 1000);
          continue;
        }

        // Handle server errors (retryable)
        if (res.statusCode >= 500) {
          const text = await res.body.text();
          logger.warn("Signing API server error", { status: res.statusCode, body: text, attempt });
          await this.sleep(this.config.retryDelayMs * (attempt + 1));
          continue;
        }

        // Handle other client errors (permanent)
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const text = await res.body.text();
          logger.error("Signing API client error", { status: res.statusCode, body: text });
          return requests.map(r => ({
            requestId: r.requestId,
            ok: false as const,
            error: {
              code: "INVALID_REQUEST" as SigningErrorCode,
              message: `Signing service error: ${res.statusCode}`,
            },
          }));
        }

        // Success
        const response = (await res.body.json()) as SignBatchResponse;
        
        logger.debug("Signing API response", {
          successCount: response.results.filter(r => r.ok).length,
          errorCount: response.results.filter(r => !r.ok).length,
        });

        return response.results;

      } catch (err: any) {
        lastError = err;
        
        // Network errors are retryable
        if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ETIMEDOUT") {
          logger.warn("Signing API network error", { error: err.message, attempt });
          await this.sleep(this.config.retryDelayMs * (attempt + 1));
          continue;
        }

        // Timeout errors are retryable
        if (err.name === "AbortError" || err.message?.includes("timeout")) {
          logger.warn("Signing API timeout", { attempt });
          await this.sleep(this.config.retryDelayMs * (attempt + 1));
          continue;
        }

        // Unknown errors - don't retry
        throw err;
      }
    }

    // All retries exhausted
    logger.error("Signing API failed after retries", { error: lastError?.message });
    
    return requests.map(r => ({
      requestId: r.requestId,
      ok: false as const,
      error: {
        code: "INTERNAL_ERROR" as SigningErrorCode,
        message: lastError?.message || "Signing API unavailable after retries",
      },
    }));
  }

  /**
   * Sign a single HTTP request (convenience method).
   */
  async signOne(request: Omit<SignRequest, "requestId">): Promise<SignResult> {
    const requestId = `sig-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const results = await this.signBatch([{ ...request, requestId }]);
    return results[0];
  }

  /**
   * Check if an error code is permanent (should NOT retry delivery).
   */
  static isPermanentError(code: SigningErrorCode): boolean {
    return PERMANENT_ERRORS.includes(code);
  }

  /**
   * Check if an error code is retryable.
   */
  static isRetryableError(code: SigningErrorCode): boolean {
    return RETRYABLE_ERRORS.includes(code);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createSigningClient(overrides?: Partial<SigningClientConfig>): SigningClient {
  const config: SigningClientConfig = {
    baseUrl: process.env.ACTIVITYPODS_URL || "http://localhost:3000",
    token: process.env.SIGNING_API_TOKEN || "",
    maxBatchSize: 200,
    maxBodyBytes: 512 * 1024,  // 512KB
    timeoutMs: 30000,
    maxRetries: 3,
    retryDelayMs: 1000,
    ...overrides,
  };

  return new SigningClient(config);
}
