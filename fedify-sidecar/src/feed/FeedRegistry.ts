import { FeedDefinitionSchema, FeedVisibility, type FeedDefinition, type PublicFeedDefinition, toPublicFeedDefinition } from "./contracts.js";

export class FeedRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedRegistryError";
  }
}

export interface FeedRegistryListOptions {
  viewerId?: string;
  includeInternal?: boolean;
}

export class FeedRegistry {
  private readonly definitions = new Map<string, FeedDefinition>();

  constructor(definitions: Iterable<FeedDefinition> = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: FeedDefinition): FeedDefinition {
    const parsed = FeedDefinitionSchema.parse(definition);
    if (this.definitions.has(parsed.id)) {
      throw new FeedRegistryError(`Feed definition already exists: ${parsed.id}`);
    }
    this.definitions.set(parsed.id, parsed);
    return parsed;
  }

  replace(definition: FeedDefinition): FeedDefinition {
    const parsed = FeedDefinitionSchema.parse(definition);
    this.definitions.set(parsed.id, parsed);
    return parsed;
  }

  getInternal(feedId: string): FeedDefinition | null {
    return this.definitions.get(feedId) ?? null;
  }

  getPublic(feedId: string, options: FeedRegistryListOptions = {}): PublicFeedDefinition | null {
    const definition = this.definitions.get(feedId);
    if (!definition || !this.isVisible(definition.visibility, options)) {
      return null;
    }
    return toPublicFeedDefinition(definition);
  }

  listPublic(options: FeedRegistryListOptions = {}): PublicFeedDefinition[] {
    return [...this.definitions.values()]
      .filter((definition) => this.isVisible(definition.visibility, options))
      .map((definition) => toPublicFeedDefinition(definition));
  }

  snapshot(): FeedDefinition[] {
    return [...this.definitions.values()];
  }

  private isVisible(visibility: FeedVisibility, options: FeedRegistryListOptions): boolean {
    if (visibility === "public") {
      return true;
    }
    if (visibility === "authenticated") {
      return Boolean(options.viewerId);
    }
    return Boolean(options.includeInternal);
  }
}
