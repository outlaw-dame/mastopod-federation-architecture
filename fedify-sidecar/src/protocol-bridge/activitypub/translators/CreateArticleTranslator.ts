import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsCreateActivity, translateCreateActivity } from "./shared.js";

export class CreateArticleTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsCreateActivity(input, "Article");
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateCreateActivity(input, ctx, "Article");
  }
}
