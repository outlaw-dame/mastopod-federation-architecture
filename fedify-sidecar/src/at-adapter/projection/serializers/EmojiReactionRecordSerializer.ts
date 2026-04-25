import type { CanonicalEmojiReaction } from "../../events/AtSocialRepoEvents.js";
import type { ActivityPodsRecordRef } from "../../lexicon/ActivityPodsEmojiLexicon.js";
import {
  ACTIVITYPODS_EMOJI_REACTION_COLLECTION,
  toActivityPodsEmojiDefinition,
} from "../../lexicon/ActivityPodsEmojiLexicon.js";

export interface ActivityPodsEmojiReactionRecord {
  $type: typeof ACTIVITYPODS_EMOJI_REACTION_COLLECTION;
  subject: ActivityPodsRecordRef;
  reaction: string;
  emoji?: ReturnType<typeof toActivityPodsEmojiDefinition> | null;
  createdAt: string;
}

export interface EmojiReactionRecordSerializer {
  serialize(input: {
    reaction: CanonicalEmojiReaction;
    target: ActivityPodsRecordRef;
  }): ActivityPodsEmojiReactionRecord;
}

export class DefaultEmojiReactionRecordSerializer implements EmojiReactionRecordSerializer {
  serialize(input: {
    reaction: CanonicalEmojiReaction;
    target: ActivityPodsRecordRef;
  }): ActivityPodsEmojiReactionRecord {
    return {
      $type: ACTIVITYPODS_EMOJI_REACTION_COLLECTION,
      subject: {
        uri: input.target.uri,
        ...(input.target.cid ? { cid: input.target.cid } : {}),
      },
      reaction: input.reaction.content,
      ...(input.reaction.emoji
        ? { emoji: toActivityPodsEmojiDefinition(input.reaction.emoji) }
        : {}),
      createdAt: input.reaction.createdAt,
    };
  }
}
