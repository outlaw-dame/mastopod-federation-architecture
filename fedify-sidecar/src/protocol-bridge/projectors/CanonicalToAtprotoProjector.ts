import { FollowAddToAtProjector } from "./atproto/FollowAddToAtProjector.js";
import { FollowRemoveToAtProjector } from "./atproto/FollowRemoveToAtProjector.js";
import { PollCreateToAtProjector } from "./atproto/PollCreateToAtProjector.js";
import { PollDeleteToAtProjector } from "./atproto/PollDeleteToAtProjector.js";
import { PollEditToAtProjector } from "./atproto/PollEditToAtProjector.js";
import { PollVoteAddToAtProjector } from "./atproto/PollVoteAddToAtProjector.js";
import { PostCreateToAtProjector } from "./atproto/PostCreateToAtProjector.js";
import { PostDeleteToAtProjector } from "./atproto/PostDeleteToAtProjector.js";
import { PostEditToAtProjector } from "./atproto/PostEditToAtProjector.js";
import { PostInteractionPolicyUpdateToAtProjector } from "./atproto/PostInteractionPolicyUpdateToAtProjector.js";
import { ProfileUpdateToAtProjector } from "./atproto/ProfileUpdateToAtProjector.js";
import { ReactionAddToAtProjector } from "./atproto/ReactionAddToAtProjector.js";
import { ReactionRemoveToAtProjector } from "./atproto/ReactionRemoveToAtProjector.js";
import { ShareAddToAtProjector } from "./atproto/ShareAddToAtProjector.js";
import { ShareRemoveToAtProjector } from "./atproto/ShareRemoveToAtProjector.js";
import { ProjectorRegistry } from "../registry/ProjectorRegistry.js";
import type { AtProjectionCommand } from "../ports/ProtocolBridgePorts.js";

export class CanonicalToAtprotoProjector extends ProjectorRegistry<AtProjectionCommand> {
  public constructor() {
    super([
      new PostCreateToAtProjector(),
      new PostEditToAtProjector(),
      new PostDeleteToAtProjector(),
      new PostInteractionPolicyUpdateToAtProjector(),
      new PollCreateToAtProjector(),
      new PollEditToAtProjector(),
      new PollDeleteToAtProjector(),
      new PollVoteAddToAtProjector(),
      new ProfileUpdateToAtProjector(),
      new ReactionAddToAtProjector(),
      new ReactionRemoveToAtProjector(),
      new ShareAddToAtProjector(),
      new ShareRemoveToAtProjector(),
      new FollowAddToAtProjector(),
      new FollowRemoveToAtProjector(),
    ]);
  }
}
