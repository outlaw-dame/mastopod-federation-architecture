import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsUpdateQuestion, translateUpdateQuestion } from "./question-shared.js";

export class UpdateQuestionTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsUpdateQuestion(input);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateUpdateQuestion(input, ctx);
  }
}
