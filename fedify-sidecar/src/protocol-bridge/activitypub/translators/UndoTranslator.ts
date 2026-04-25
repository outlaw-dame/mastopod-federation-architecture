import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsSocialActivity, translateUndoActivity } from "./social.js";

export class UndoTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsSocialActivity(input, "Undo");
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateUndoActivity(input, ctx);
  }
}
