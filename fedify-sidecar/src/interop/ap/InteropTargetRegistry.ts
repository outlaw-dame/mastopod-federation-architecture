export type InteropExecutionMode =
  | "local_container"
  | "recorded_fixture"
  | "opt_in_external";

export type InteropCiTier = "core" | "extended" | "manual_only";
export type InteropTargetStatus = "existing" | "planned" | "hosted_only";

export interface InteropTargetDefinition {
  id: string;
  family: string;
  aliases: readonly string[];
  sourceRepository?: string;
  executionModes: readonly InteropExecutionMode[];
  ciTier: InteropCiTier;
  status: InteropTargetStatus;
  /** Exact image tag / release / commit must be recorded before local execution is enabled. */
  versionPolicy: "existing_pin" | "pin_before_enable" | "hosted_observed_version";
  capabilities: readonly string[];
  notes?: readonly string[];
}

/**
 * Governing target set for ActivityPub interoperability hardening.
 *
 * Rules:
 * - New requested targets are additive; they never replace families already
 *   required by ACTIVITYPUB-INTEROPERABILITY-HARDENING.md.
 * - Required CI never depends on the public Internet.
 * - `planned` local targets MUST receive an exact official image/release/commit
 *   pin before their executable lane can be enabled.
 * - A related open-source implementation may provide dialect coverage for a
 *   hosted service, but must not be reported as exact hosted-service conformance.
 */
export const AP_INTEROP_TARGETS: readonly InteropTargetDefinition[] = [
  {
    id: "gotosocial",
    family: "GoToSocial",
    aliases: [],
    sourceRepository: "superseriousbusiness/gotosocial",
    executionModes: ["local_container"],
    ciTier: "core",
    status: "existing",
    versionPolicy: "existing_pin",
    capabilities: ["actor", "follow", "accept", "note", "media", "target_persistence"],
  },
  {
    id: "mastodon",
    family: "Mastodon",
    aliases: [],
    sourceRepository: "mastodon/mastodon",
    executionModes: ["local_container"],
    ciTier: "core",
    status: "existing",
    versionPolicy: "existing_pin",
    capabilities: ["actor", "follow", "accept", "note", "media", "target_persistence"],
  },
  {
    id: "akkoma",
    family: "Akkoma/Pleroma",
    aliases: ["pleroma"],
    sourceRepository: "AkkomaGang/akkoma",
    executionModes: ["local_container"],
    ciTier: "extended",
    status: "existing",
    versionPolicy: "existing_pin",
    capabilities: ["actor", "follow", "accept", "note", "media", "target_persistence"],
    notes: ["Current harness pin is Akkoma v3.18.1 commit 792385f4ac1e258c21a3a900342c4ded14db1727."],
  },
  {
    id: "misskey",
    family: "Misskey",
    aliases: ["misskey-derivatives"],
    sourceRepository: "misskey-dev/misskey",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "existing",
    versionPolicy: "existing_pin",
    capabilities: ["actor", "note", "follow", "reaction", "quote", "poll", "custom_emoji", "target_persistence"],
    notes: ["Both delivery modes and exact remote persistence passed at architecture commit db33a7fb47a1e4e9cf9e2b22f6d42d984d81e847 in CI run 32650757788."],
  },
  {
    id: "pixelfed",
    family: "Pixelfed",
    aliases: [],
    sourceRepository: "pixelfed/pixelfed",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "existing",
    versionPolicy: "existing_pin",
    capabilities: ["actor", "note", "image", "media", "follow", "collection", "target_persistence"],
    notes: ["Both delivery modes and exact remote persistence passed at architecture commit 9a2fd328d779cef178e56af06c64f9717bd5e23a in CI run 32648934561."],
  },
  {
    id: "peertube",
    family: "PeerTube",
    aliases: [],
    sourceRepository: "Chocobozzz/PeerTube",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "video", "article", "announce", "follow", "media"],
  },
  {
    id: "lemmy",
    family: "Lemmy/PieFed",
    aliases: ["piefed"],
    sourceRepository: "LemmyNet/lemmy",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "group", "page", "note", "announce", "collection"],
    notes: ["PieFed must receive its own concrete target definition when enabled; this family entry does not claim binary equivalence."],
  },
  {
    id: "wordpress-activitypub",
    family: "WordPress ActivityPub",
    aliases: ["wordpress"],
    sourceRepository: "Automattic/wordpress-activitypub",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "article", "note", "create", "update", "delete"],
  },
  {
    id: "ghost",
    family: "Ghost ActivityPub",
    aliases: ["ghost-cms"],
    sourceRepository: "TryGhost/ActivityPub",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "article", "note", "follow", "create", "update", "delete"],
    notes: ["Local harness needs the Ghost ActivityPub service topology/proxy boundary, not a generic Mastodon-shaped substitute."],
  },
  {
    id: "writefreely",
    family: "WriteFreely",
    aliases: ["write-as-family-local"],
    sourceRepository: "writefreely/writefreely",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "article", "create", "update", "delete"],
    notes: ["Provides local open-source family coverage; it is not exact Write.as hosted-service conformance."],
  },
  {
    id: "bonfire",
    family: "Bonfire",
    aliases: [],
    sourceRepository: "bonfire-networks/bonfire-app",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "note", "follow", "group", "extensions", "visibility"],
  },
  {
    id: "mobilizon",
    family: "Mobilizon",
    aliases: [],
    sourceRepository: "framasoft/mobilizon",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "group", "event", "follow", "announce", "collection"],
  },
  {
    id: "castopod",
    family: "Castopod",
    aliases: [],
    sourceRepository: "ad-aures/castopod",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "existing",
    versionPolicy: "existing_pin",
    capabilities: ["actor", "podcast", "audio", "article", "media", "follow", "target_persistence"],
    notes: ["Both delivery modes and exact remote persistence passed at architecture commit 22ff513af9dc78b9c0d11f140cadb58e610bf66a in CI run 32651949364."],
  },
  {
    id: "emissary-bandwagon",
    family: "Emissary/Bandwagon",
    aliases: ["bandwagon", "emissary"],
    sourceRepository: "EmissarySocial/emissary",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "music", "audio", "article", "follow", "extensions"],
    notes: ["Bandwagon coverage targets the Emissary-based application family, not unrelated repositories named Emissary."],
  },
  {
    id: "friendica",
    family: "Friendica",
    aliases: [],
    sourceRepository: "friendica/friendica",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "note", "article", "follow", "like", "announce", "event"],
  },
  {
    id: "funkwhale",
    family: "Funkwhale",
    aliases: [],
    sourceRepository: "funkwhale/funkwhale",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "audio", "music", "collection", "follow", "library"],
  },
  {
    id: "loops",
    family: "Loops",
    aliases: ["joinloops"],
    sourceRepository: "joinloops/loops-server",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "video", "media", "follow", "note"],
  },
  {
    id: "owncast",
    family: "Owncast",
    aliases: [],
    sourceRepository: "owncast/owncast",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "stream", "video", "announce", "follow"],
    notes: ["Owncast is a single-server actor model; tests must not assume Mastodon-style per-user actors."],
  },
  {
    id: "vernissage",
    family: "Vernissage",
    aliases: [],
    sourceRepository: "VernissageApp/VernissageServer",
    executionModes: ["local_container", "recorded_fixture"],
    ciTier: "extended",
    status: "planned",
    versionPolicy: "pin_before_enable",
    capabilities: ["actor", "image", "media", "follow", "extensions", "location", "exif"],
    notes: ["Preserve and bound custom JSON-LD terms such as EXIF/geolocation/category metadata."],
  },
  {
    id: "microblog-hosted",
    family: "Micro.blog",
    aliases: ["micro.blog"],
    executionModes: ["recorded_fixture", "opt_in_external"],
    ciTier: "manual_only",
    status: "hosted_only",
    versionPolicy: "hosted_observed_version",
    capabilities: ["actor", "note", "article", "follow", "webfinger"],
    notes: ["Never make required CI depend on Micro.blog availability. External live checks require explicit opt-in."],
  },
  {
    id: "write-as-hosted",
    family: "Write.as",
    aliases: ["write.as"],
    executionModes: ["recorded_fixture", "opt_in_external"],
    ciTier: "manual_only",
    status: "hosted_only",
    versionPolicy: "hosted_observed_version",
    capabilities: ["actor", "article", "create", "update"],
    notes: ["WriteFreely evidence must never be relabeled as exact Write.as hosted-service evidence."],
  },
] as const;

export function getInteropTarget(idOrAlias: string): InteropTargetDefinition | undefined {
  const normalized = idOrAlias.trim().toLowerCase();
  return AP_INTEROP_TARGETS.find((target) =>
    target.id === normalized || target.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
}

export function assertInteropTargetRegistry(): void {
  const ids = new Set<string>();
  const aliases = new Set<string>();

  for (const target of AP_INTEROP_TARGETS) {
    const normalizedId = target.id.toLowerCase();
    if (ids.has(normalizedId) || aliases.has(normalizedId)) {
      throw new Error(`duplicate ActivityPub interop target id: ${target.id}`);
    }
    ids.add(normalizedId);

    for (const alias of target.aliases) {
      const normalizedAlias = alias.toLowerCase();
      if (ids.has(normalizedAlias) || aliases.has(normalizedAlias)) {
        throw new Error(`duplicate ActivityPub interop target alias: ${alias}`);
      }
      aliases.add(normalizedAlias);
    }

    if (target.status === "hosted_only") {
      if (target.executionModes.includes("local_container")) {
        throw new Error(`hosted-only target cannot declare local_container: ${target.id}`);
      }
      if (target.ciTier !== "manual_only") {
        throw new Error(`hosted-only target cannot enter required CI: ${target.id}`);
      }
    }

    if (target.executionModes.includes("opt_in_external") && target.ciTier !== "manual_only") {
      throw new Error(`public Internet target must be manual-only: ${target.id}`);
    }

    if (target.status === "planned" && target.versionPolicy !== "pin_before_enable") {
      throw new Error(`planned local target must be pinned before enable: ${target.id}`);
    }
  }
}

assertInteropTargetRegistry();
