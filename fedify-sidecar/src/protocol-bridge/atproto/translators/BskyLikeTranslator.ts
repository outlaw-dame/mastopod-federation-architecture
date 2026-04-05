import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsLikeEnvelope, translateLikeEnvelope } from "./social.js";

export class BskyLikeTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsLikeEnvelope(input);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateLikeEnvelope(input, ctx);
  }
}
