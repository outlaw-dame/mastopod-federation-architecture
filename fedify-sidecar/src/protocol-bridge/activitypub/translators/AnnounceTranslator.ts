import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsSocialActivity, translateAnnounceActivity } from "./social.js";

export class AnnounceTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsSocialActivity(input, "Announce");
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateAnnounceActivity(input, ctx);
  }
}
