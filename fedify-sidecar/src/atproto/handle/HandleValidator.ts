/**
 * V6.5 Handle Validator - ATProto Handle Validation and Resolution
 *
 * Validates and resolves ATProto handles using multiple methods:
 * 1. DNS TXT record (`_atproto.<handle>`)
 * 2. Well-known HTTP endpoint (`/.well-known/atproto-did`)
 * 3. PLC directory lookup
 */

export interface HandleValidationResult {
  valid: boolean;
  did?: string;
  method?: "dns" | "well-known" | "plc";
  error?: string;
  validatedAt: string;
}

interface GoogleDnsAnswer {
  type?: number;
  data?: string;
}

interface GoogleDnsResponse {
  Answer?: GoogleDnsAnswer[];
}

interface PlcResolveResponse {
  did?: string;
}

export class HandleValidator {
  private readonly DNS_TIMEOUT_MS = 5000;
  private readonly HTTP_TIMEOUT_MS = 10000;
  private readonly reservedTlds = new Set([
    "arpa",
    "test",
    "example",
    "invalid",
    "localhost",
  ]);

  isValidFormat(handle: string): boolean {
    if (!handle || typeof handle !== "string") {
      return false;
    }

    if (handle.length > 253 || handle !== handle.toLowerCase()) {
      return false;
    }

    const labels = handle.split(".");
    if (labels.length < 2) {
      return false;
    }

    const tld = labels[labels.length - 1];
    if (!tld || this.reservedTlds.has(tld)) {
      return false;
    }

    for (const label of labels) {
      if (label.length === 0 || label.length > 63) {
        return false;
      }

      if (label.startsWith("-") || label.endsWith("-")) {
        return false;
      }

      if (!/^[a-z0-9-]+$/.test(label)) {
        return false;
      }
    }

    return true;
  }

  async validateHandle(handle: string): Promise<HandleValidationResult> {
    const validatedAt = new Date().toISOString();

    if (!this.isValidFormat(handle)) {
      return {
        valid: false,
        error: "Invalid handle format",
        validatedAt,
      };
    }

    try {
      const did = await this.resolveDnsTxt(handle);
      if (did) {
        return { valid: true, did, method: "dns", validatedAt };
      }
    } catch {
      // Fall through to the next resolution method.
    }

    try {
      const did = await this.resolveWellKnown(handle);
      if (did) {
        return { valid: true, did, method: "well-known", validatedAt };
      }
    } catch {
      // Fall through to the next resolution method.
    }

    try {
      const did = await this.resolvePlc(handle);
      if (did) {
        return { valid: true, did, method: "plc", validatedAt };
      }
    } catch {
      // Let the final invalid result speak for itself.
    }

    return {
      valid: false,
      error: "Could not resolve handle to DID",
      validatedAt,
    };
  }

  async isHandleAvailable(handle: string): Promise<boolean> {
    if (!this.isValidFormat(handle)) {
      return false;
    }

    const result = await this.validateHandle(handle);
    return !result.valid;
  }

  async verifyBidirectionalLink(handle: string, did: string): Promise<boolean> {
    const result = await this.validateHandle(handle);
    if (!result.valid || result.did !== did) {
      return false;
    }

    return true;
  }

  private async resolveDnsTxt(handle: string): Promise<string | null> {
    try {
      const response = await fetch(
        `https://dns.google/resolve?name=_atproto.${handle}&type=TXT`,
        {
          signal: AbortSignal.timeout(this.DNS_TIMEOUT_MS),
        }
      );

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as GoogleDnsResponse;
      for (const answer of data.Answer ?? []) {
        if (answer.type !== 16 || !answer.data) {
          continue;
        }

        const match = answer.data.match(/v=atproto;t=did;v=(did:[^";\s]+)/);
        if (match?.[1]) {
          return match[1];
        }
      }

      return null;
    } catch (error) {
      throw new Error(
        `DNS resolution failed for ${handle}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async resolveWellKnown(handle: string): Promise<string | null> {
    try {
      const response = await fetch(`https://${handle}/.well-known/atproto-did`, {
        method: "GET",
        headers: {
          Accept: "text/plain",
        },
        signal: AbortSignal.timeout(this.HTTP_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const did = (await response.text()).trim();
      return did.startsWith("did:") ? did : null;
    } catch (error) {
      throw new Error(
        `Well-known resolution failed for ${handle}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async resolvePlc(handle: string): Promise<string | null> {
    try {
      const response = await fetch(`https://plc.directory/resolve/${handle}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.HTTP_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as PlcResolveResponse;
      return data.did ?? null;
    } catch (error) {
      throw new Error(
        `PLC resolution failed for ${handle}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
