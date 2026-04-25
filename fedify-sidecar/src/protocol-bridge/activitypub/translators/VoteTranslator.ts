/**
 * VoteTranslator
 *
 * Handles FEP-9967 vote activities: Create{Note} where the Note has `name`
 * (option text) and `inReplyTo` (poll URI) but NO `content` property.
 *
 * IMPORTANT: This translator MUST be registered before CreateNoteTranslator in
 * the TranslatorRegistry so it intercepts vote notes before the generic note
 * handler claims them.
 */
import type { CanonicalIntent } from "../../canonical/CanonicalIntent.js";
import type { TranslationContext } from "../../ports/ProtocolBridgePorts.js";
import type { ProtocolTranslator } from "../../registry/TranslatorRegistry.js";
import { supportsVote, translateVote } from "./question-shared.js";

export class VoteTranslator implements ProtocolTranslator<unknown> {
  public supports(input: unknown): boolean {
    return supportsVote(input);
  }

  public async translate(input: unknown, ctx: TranslationContext): Promise<CanonicalIntent | null> {
    return translateVote(input, ctx);
  }
}
