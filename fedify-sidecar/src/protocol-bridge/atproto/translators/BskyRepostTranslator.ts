import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsRepostEnvelope, translateRepostEnvelope } from "./social.js";

export class BskyRepostTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsRepostEnvelope(input);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateRepostEnvelope(input, ctx);
  }
}
