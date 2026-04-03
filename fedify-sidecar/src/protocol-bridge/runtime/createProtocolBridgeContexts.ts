import type { IdentityBinding } from "../../core-domain/identity/IdentityBinding.js";
import type { IdentityBindingRepository } from "../../core-domain/identity/IdentityBindingRepository.js";
import type { AtAliasRecord, AtAliasStore } from "../../at-adapter/repo/AtAliasStore.js";
import { buildCanonicalIntentId } from "../idempotency/CanonicalIntentIdBuilder.js";
import type {
  ActivityObjectResolutionOptions,
  ProjectionContext,
  TranslationContext,
} from "../ports/ProtocolBridgePorts.js";
import type { CanonicalActorRef } from "../canonical/CanonicalActorRef.js";
import type { CanonicalObjectRef } from "../canonical/CanonicalObjectRef.js";

export interface ProtocolBridgeContexts {
  translationContext: TranslationContext;
  projectionContext: ProjectionContext;
}

export interface ProtocolBridgeContextOptions {
  activityResolver?: {
    resolveActivityObject(
      activityId: string,
      options?: ActivityObjectResolutionOptions,
    ): Promise<Record<string, unknown> | null>;
  };
  localPdsOrigin?: string;
}

export function createProtocolBridgeContexts(
  identityRepo: IdentityBindingRepository,
  aliasStore: AtAliasStore,
  options: ProtocolBridgeContextOptions = {},
): ProtocolBridgeContexts {
  const translationContext: TranslationContext = {
    now: () => new Date(),
    resolveActorRef: async (ref: CanonicalActorRef) => {
      const binding = await resolveBinding(identityRepo, ref);
      return mergeActorRef(ref, binding);
    },
    resolveObjectRef: async (ref: CanonicalObjectRef) => {
      const alias = await resolveAlias(aliasStore, ref);
      return {
        canonicalObjectId: alias?.canonicalRefId ?? ref.canonicalObjectId,
        atUri: ref.atUri ?? alias?.atUri ?? null,
        cid: ref.cid ?? alias?.cid ?? null,
        activityPubObjectId: ref.activityPubObjectId ?? alias?.activityPubObjectId ?? null,
        canonicalUrl: ref.canonicalUrl ?? alias?.canonicalUrl ?? null,
      };
    },
    resolveBlobUrl: async (did, cid) => resolveBlobUrl(identityRepo, did, cid, options.localPdsOrigin),
    resolveActivityObject: options.activityResolver
      ? async (activityId, resolutionOptions) =>
          options.activityResolver!.resolveActivityObject(activityId, resolutionOptions)
      : undefined,
  };

  return {
    translationContext,
    projectionContext: {
      ...translationContext,
      buildIntentId: buildCanonicalIntentId,
    },
  };
}

async function resolveBinding(
  identityRepo: IdentityBindingRepository,
  ref: CanonicalActorRef,
): Promise<IdentityBinding | null> {
  if (ref.canonicalAccountId) {
    const binding = await identityRepo.getByCanonicalAccountId(ref.canonicalAccountId);
    if (binding) {
      return binding;
    }
  }
  if (ref.did) {
    const binding = await identityRepo.getByAtprotoDid(ref.did);
    if (binding) {
      return binding;
    }
  }
  if (ref.activityPubActorUri) {
    const binding = await identityRepo.getByActivityPubActorUri(ref.activityPubActorUri);
    if (binding) {
      return binding;
    }
  }
  if (ref.webId) {
    const binding = await identityRepo.getByWebId(ref.webId);
    if (binding) {
      return binding;
    }
  }
  if (ref.handle) {
    const binding = await identityRepo.getByAtprotoHandle(ref.handle);
    if (binding) {
      return binding;
    }
  }
  return null;
}

function mergeActorRef(ref: CanonicalActorRef, binding: IdentityBinding | null): CanonicalActorRef {
  return {
    canonicalAccountId: ref.canonicalAccountId ?? binding?.canonicalAccountId ?? null,
    did: ref.did ?? binding?.atprotoDid ?? null,
    webId: ref.webId ?? binding?.webId ?? null,
    activityPubActorUri: ref.activityPubActorUri ?? binding?.activityPubActorUri ?? null,
    handle: ref.handle ?? binding?.atprotoHandle ?? null,
  };
}

async function resolveAlias(
  aliasStore: AtAliasStore,
  ref: CanonicalObjectRef,
): Promise<AtAliasRecord | null> {
  if (ref.canonicalObjectId) {
    const alias = await aliasStore.getByCanonicalRefId(ref.canonicalObjectId);
    if (alias && !alias.deletedAt) {
      return alias;
    }
  }

  if (!ref.atUri) {
    return null;
  }

  const parsed = parseAtUri(ref.atUri);
  if (!parsed) {
    return null;
  }

  const aliases = await aliasStore.listByDid(parsed.did);
  return aliases.find(
    (alias) =>
      alias.collection === parsed.collection &&
      alias.rkey === parsed.rkey &&
      !alias.deletedAt,
  ) ?? null;
}

function parseAtUri(atUri: string): { did: string; collection: string; rkey: string } | null {
  const match = atUri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) {
    return null;
  }
  return {
    did: match[1]!,
    collection: match[2]!,
    rkey: match[3]!,
  };
}

async function resolveBlobUrl(
  identityRepo: IdentityBindingRepository,
  did: string,
  cid: string,
  localPdsOrigin?: string,
): Promise<string | null> {
  if (!did?.trim() || !cid?.trim()) {
    return null;
  }

  const binding = await identityRepo.getByAtprotoDid(did.trim());
  const baseOrigin = binding?.atprotoSource === "external"
    ? normalizePublicOrigin(binding.atprotoPdsEndpoint)
    : normalizePublicOrigin(localPdsOrigin ?? binding?.atprotoPdsEndpoint ?? null);
  if (!baseOrigin) {
    return null;
  }

  const url = new URL("/xrpc/com.atproto.sync.getBlob", baseOrigin);
  url.searchParams.set("did", did.trim());
  url.searchParams.set("cid", cid.trim());
  return url.toString();
}

function normalizePublicOrigin(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const isLocalHttp = parsed.protocol === "http:" && new Set(["localhost", "127.0.0.1", "::1"]).has(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLocalHttp) {
    return null;
  }

  return parsed.toString();
}
