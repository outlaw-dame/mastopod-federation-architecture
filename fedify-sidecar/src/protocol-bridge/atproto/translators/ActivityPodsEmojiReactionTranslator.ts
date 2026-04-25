import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import {
  supportsEmojiReactionEnvelope,
  translateEmojiReactionEnvelope,
} from "./social.js";

export class ActivityPodsEmojiReactionTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsEmojiReactionEnvelope(input);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateEmojiReactionEnvelope(input, ctx);
  }
}
