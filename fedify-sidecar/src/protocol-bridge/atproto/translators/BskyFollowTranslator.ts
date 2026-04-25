import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsFollowEnvelope, translateFollowEnvelope } from "./social.js";

export class BskyFollowTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsFollowEnvelope(input);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateFollowEnvelope(input, ctx);
  }
}
