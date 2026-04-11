/**
 * V6.5 PLC Directory Client - did:plc Operations
 *
 * Communicates with the PLC directory to create and update did:plc identifiers.
 * The PLC directory is the authoritative registry for did:plc DIDs.
 */

import type { SigningService } from "../../core-domain/contracts/SigningContracts.js";

export interface PlcDirectoryConfig {
  directoryUrl: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface PlcOperation {
  type: string;
  rotationKeys: string[];
  verificationMethods: Record<string, string>;
  alsoKnownAs: string[];
  services: Record<string, { type: string; endpoint: string }>;
  prev?: string;
  sig?: string;
}

export interface PlcDirectoryEntry {
  did: string;
  opCid: string;
  operation: PlcOperation;
  timestamp: string;
}

interface PlcDirectoryResponse {
  did?: string;
  opCid?: string;
  operation?: PlcOperation;
}

export class PlcDirectoryClient {
  private readonly config: PlcDirectoryConfig;

  constructor(
    private readonly signingService: SigningService,
    config?: Partial<PlcDirectoryConfig>
  ) {
    this.config = {
      directoryUrl: "https://plc.directory",
      timeoutMs: 30000,
      maxRetries: 3,
      ...config,
    };
  }

  async createDid(
    operation: PlcOperation,
    canonicalAccountId: string,
    _rotationKeyRef: string
  ): Promise<PlcDirectoryEntry> {
    const signedOperation = await this.signOperation(
      operation,
      canonicalAccountId,
      ""
    );
    return this.submitOperation(signedOperation);
  }

  async updateDid(
    did: string,
    operation: PlcOperation,
    canonicalAccountId: string,
    _rotationKeyRef: string
  ): Promise<PlcDirectoryEntry> {
    const current = await this.getEntry(did);
    const nextOperation: PlcOperation = {
      ...operation,
      prev: current.opCid,
    };

    const signedOperation = await this.signOperation(
      nextOperation,
      canonicalAccountId,
      did
    );
    return this.submitOperation(signedOperation, did);
  }

  async getEntry(did: string): Promise<PlcDirectoryEntry> {
    const data = await this.fetchWithRetries<PlcDirectoryResponse>(
      `${this.config.directoryUrl}/${did}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
      `DID not found: ${did}`
    );

    return this.toDirectoryEntry(data, did);
  }

  async resolveHandle(handle: string): Promise<string> {
    const data = await this.fetchWithRetries<{ did?: string }>(
      `${this.config.directoryUrl}/resolve/${handle}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      }
    );

    if (!data.did) {
      throw new Error(`PLC directory returned no DID for handle ${handle}`);
    }

    return data.did;
  }

  private async signOperation(
    operation: PlcOperation,
    canonicalAccountId: string,
    did: string
  ): Promise<PlcOperation> {
    const operationBytesBase64 = Buffer.from(
      this.serializeOperation(operation)
    ).toString("base64");

    const signResponse = await this.signingService.signPlcOperation({
      canonicalAccountId,
      did,
      operationBytesBase64,
    });

    return {
      ...operation,
      sig: signResponse.signatureBase64Url,
    };
  }

  private async submitOperation(
    operation: PlcOperation,
    did?: string
  ): Promise<PlcDirectoryEntry> {
    const url = did ? `${this.config.directoryUrl}/${did}` : this.config.directoryUrl;
    const method = did ? "PUT" : "POST";

    const data = await this.fetchWithRetries<PlcDirectoryResponse>(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(operation),
    });

    return this.toDirectoryEntry(data, did);
  }

  private async fetchWithRetries<T>(
    url: string,
    init: RequestInit,
    notFoundMessage?: string
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });

        if (!response.ok) {
          if (response.status === 404 && notFoundMessage) {
            throw new Error(notFoundMessage);
          }

          if (response.status >= 500 && attempt < this.config.maxRetries - 1) {
            await this.delay(1000 * (attempt + 1));
            continue;
          }

          throw new Error(`PLC directory error: ${response.status}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (attempt === this.config.maxRetries - 1) {
          break;
        }
        await this.delay(1000 * (attempt + 1));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Max retries exceeded");
  }

  private toDirectoryEntry(
    data: PlcDirectoryResponse,
    fallbackDid?: string
  ): PlcDirectoryEntry {
    const did = data.did ?? fallbackDid;
    if (!did) {
      throw new Error("PLC directory response missing DID");
    }
    if (!data.opCid) {
      throw new Error(`PLC directory response missing opCid for ${did}`);
    }
    if (!data.operation) {
      throw new Error(`PLC directory response missing operation for ${did}`);
    }

    return {
      did,
      opCid: data.opCid,
      operation: data.operation,
      timestamp: new Date().toISOString(),
    };
  }

  private serializeOperation(operation: PlcOperation): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(operation));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
