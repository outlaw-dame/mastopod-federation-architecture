import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsUpdateActivity, translateUpdateActivity } from "./shared.js";

export class UpdateArticleTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsUpdateActivity(input, "Article");
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateUpdateActivity(input, ctx, "Article");
  }
}
