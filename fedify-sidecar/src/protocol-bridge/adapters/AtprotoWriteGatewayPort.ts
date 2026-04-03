import { createHash } from "node:crypto";
import type { AtAccountResolver, AtSessionContext } from "../../at-adapter/auth/AtSessionTypes.js";
import {
  SUPPORTED_COLLECTIONS,
  type AtWriteGateway,
} from "../../at-adapter/writes/AtWriteTypes.js";
import { validateRkey } from "../../at-adapter/repo/AtRkeyService.js";
import { sanitizeJsonObject } from "../../utils/safe-json.js";
import type { AtProjectionCommand, AtprotoWritePort } from "../ports/ProtocolBridgePorts.js";
import { ProtocolBridgeAdapterError } from "./ProtocolBridgeAdapterError.js";

export interface LinkPreviewThumbResolver {
  resolveThumbBlob(
    did: string,
    thumbUrl: string,
    scope: {
      canonicalIntentId?: string | null;
      canonicalRefIdHint?: string | null;
      externalUri?: string | null;
    },
  ): Promise<unknown | null>;
}

export interface AtprotoWriteGatewayPortLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface AtprotoWriteGatewayPortOptions {
  maxCommandsPerBatch?: number;
  maxRecordBytes?: number;
  supportedCollections?: ReadonlySet<string>;
  linkPreviewThumbResolver?: LinkPreviewThumbResolver;
  logger?: AtprotoWriteGatewayPortLogger;
}

export class AtprotoWriteGatewayPort implements AtprotoWritePort {
  private readonly maxCommandsPerBatch: number;
  private readonly maxRecordBytes: number;
  private readonly supportedCollections: ReadonlySet<string>;
  private readonly linkPreviewThumbResolver?: LinkPreviewThumbResolver;
  private readonly logger?: AtprotoWriteGatewayPortLogger;

  public constructor(
    private readonly writeGateway: AtWriteGateway,
    private readonly accountResolver: AtAccountResolver,
    options: AtprotoWriteGatewayPortOptions = {},
  ) {
    this.maxCommandsPerBatch = options.maxCommandsPerBatch ?? 8;
    this.maxRecordBytes = options.maxRecordBytes ?? 256_000;
    this.supportedCollections = options.supportedCollections ?? SUPPORTED_COLLECTIONS;
    this.linkPreviewThumbResolver = options.linkPreviewThumbResolver;
    this.logger = options.logger;
  }

  public async apply(commands: AtProjectionCommand[]): Promise<void> {
    if (commands.length === 0) {
      return;
    }
    if (commands.length > this.maxCommandsPerBatch) {
      throw new ProtocolBridgeAdapterError(
        "AT_BRIDGE_BATCH_TOO_LARGE",
        `ATProto bridge batch exceeds maximum size ${this.maxCommandsPerBatch}.`,
      );
    }

    const prepared = commands.map((command) => this.prepareCommand(command));
    const repoIds = new Set(prepared.map((command) => command.repoDid));
    if (repoIds.size !== 1) {
      throw new ProtocolBridgeAdapterError(
        "AT_BRIDGE_MULTI_REPO_UNSUPPORTED",
        "A single ATProto bridge batch must target exactly one repository DID.",
      );
    }

    const repoDid = prepared[0]!.repoDid;
    const resolved = await this.accountResolver.resolveByIdentifier(repoDid);
    if (!resolved) {
      throw new ProtocolBridgeAdapterError(
        "AT_BRIDGE_REPO_NOT_LOCAL",
        `No active local ATProto account binding was found for ${repoDid}.`,
        404,
      );
    }
    if (resolved.atprotoSource !== "local" || !resolved.atprotoManaged) {
      throw new ProtocolBridgeAdapterError(
        "AT_BRIDGE_EXTERNAL_REPO_UNSUPPORTED",
        `Projected writes are only allowed for locally managed ATProto repos. Refusing ${repoDid}.`,
        403,
      );
    }
    if (resolved.did !== repoDid) {
      throw new ProtocolBridgeAdapterError(
        "AT_BRIDGE_REPO_DID_MISMATCH",
        `Resolved repo DID ${resolved.did} does not match projected repo ${repoDid}.`,
      );
    }

    const auth: AtSessionContext = {
      canonicalAccountId: resolved.canonicalAccountId,
      did: resolved.did,
      handle: resolved.handle,
      scope: "full",
    };

    for (const command of prepared) {
      switch (command.kind) {
        case "createRecord":
          await this.writeGateway.createRecord(
            {
              repo: resolved.did,
              collection: command.collection,
              ...(command.rkey ? { rkey: command.rkey } : {}),
              validate: true,
              record: await this.buildNativeRecord(command),
            },
            auth,
          );
          break;
        case "updateRecord":
          await this.writeGateway.putRecord(
            {
              repo: resolved.did,
              collection: command.collection,
              rkey: command.rkey!,
              validate: true,
              record: await this.buildNativeRecord(command),
            },
            auth,
          );
          break;
        case "deleteRecord":
          await this.writeGateway.deleteRecord(
            {
              repo: resolved.did,
              collection: command.collection,
              rkey: command.rkey!,
              ...(command.canonicalRefIdHint
                ? { bridgeCanonicalRefId: command.canonicalRefIdHint }
                : {}),
              ...(command.metadata
                ? {
                    bridgeMetadata: sanitizeJsonObject(command.metadata as unknown as Record<string, unknown>, {
                      maxBytes: this.maxRecordBytes,
                    }),
                  }
                : {}),
            },
            auth,
          );
          break;
        default:
          throw new ProtocolBridgeAdapterError(
            "AT_BRIDGE_COMMAND_INVALID",
            `Unsupported ATProto projection command kind: ${(command as { kind?: string }).kind ?? "unknown"}.`,
          );
      }
    }
  }

  private prepareCommand(command: AtProjectionCommand): AtProjectionCommand {
    if (!command.repoDid?.startsWith("did:")) {
      throw new ProtocolBridgeAdapterError(
        "AT_BRIDGE_REPO_DID_INVALID",
        "ATProto projected commands must target a concrete repository DID.",
      );
    }
    if (!this.supportedCollections.has(command.collection)) {
      throw new ProtocolBridgeAdapterError(
        "AT_BRIDGE_COLLECTION_UNSUPPORTED",
        `Collection ${command.collection} is not enabled on the native ATProto write path.`,
      );
    }

    if (command.kind === "createRecord" || command.kind === "updateRecord") {
      if (!command.record) {
        throw new ProtocolBridgeAdapterError(
          "AT_BRIDGE_RECORD_REQUIRED",
          `ATProto ${command.kind} requires a record payload for ${command.collection}.`,
        );
      }
    }

    if ((command.kind === "updateRecord" || command.kind === "deleteRecord") && !command.rkey) {
      throw new ProtocolBridgeAdapterError(
        "AT_BRIDGE_RKEY_REQUIRED",
        `ATProto ${command.kind} requires an rkey for ${command.collection}.`,
      );
    }
    if (command.rkey && !validateRkey(command.rkey)) {
      throw new ProtocolBridgeAdapterError(
        "AT_BRIDGE_RKEY_INVALID",
        `ATProto ${command.kind} received an invalid rkey for ${command.collection}.`,
      );
    }

    return {
      ...command,
      ...(command.record
        ? {
            record: sanitizeJsonObject(command.record, {
              maxBytes: this.maxRecordBytes,
            }),
          }
        : {}),
    };
  }

  private async buildNativeRecord(command: AtProjectionCommand): Promise<Record<string, unknown>> {
    const record = command.record ? { ...command.record } : {};
    await this.attachExternalEmbedThumb(record, command);
    if (command.canonicalRefIdHint) {
      record["_bridgeCanonicalRefId"] = command.canonicalRefIdHint;
    }
    if (command.metadata) {
      record["_bridgeMetadata"] = command.metadata;
    }
    return sanitizeJsonObject(record, {
      maxBytes: this.maxRecordBytes,
    });
  }

  private async attachExternalEmbedThumb(
    record: Record<string, unknown>,
    command: AtProjectionCommand,
  ): Promise<void> {
    if (!this.linkPreviewThumbResolver || !command.linkPreviewThumbUrlHint) {
      return;
    }

    const embed = toPlainObject(record["embed"]);
    if (!embed || embed["$type"] !== "app.bsky.embed.external") {
      return;
    }

    const external = toPlainObject(embed["external"]);
    if (!external || external["thumb"] != null) {
      return;
    }

    const externalUri = typeof external["uri"] === "string" ? external["uri"].trim() : "";
    if (!externalUri) {
      return;
    }

    try {
      const thumbBlob = await this.linkPreviewThumbResolver.resolveThumbBlob(
        command.repoDid,
        command.linkPreviewThumbUrlHint,
        {
          canonicalIntentId: command.metadata?.canonicalIntentId ?? null,
          canonicalRefIdHint: command.canonicalRefIdHint ?? null,
          externalUri,
        },
      );
      if (thumbBlob) {
        external["thumb"] = thumbBlob as Record<string, unknown>;
      }
    } catch (error) {
      this.logger?.warn(
        "ATProto bridge link preview thumbnail resolution failed; continuing without embed thumbnail",
        {
          repoDid: command.repoDid,
          collection: command.collection,
          rkey: command.rkey ?? deriveFallbackRkey(command),
          thumbUrl: command.linkPreviewThumbUrlHint,
          externalUri,
          canonicalIntentId: command.metadata?.canonicalIntentId ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}

function toPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function deriveFallbackRkey(command: AtProjectionCommand): string {
  return createHash("sha256")
    .update(`${command.repoDid}:${command.collection}:${command.metadata?.canonicalIntentId ?? ""}`)
    .digest("hex")
    .slice(0, 13);
}
