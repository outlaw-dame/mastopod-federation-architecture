import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsDeleteQuestion, translateDeleteQuestion } from "./question-shared.js";

export class DeleteQuestionTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsDeleteQuestion(input);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateDeleteQuestion(input, ctx);
  }
}
