import { FollowAddToAtProjector } from "./atproto/FollowAddToAtProjector.js";
import { FollowRemoveToAtProjector } from "./atproto/FollowRemoveToAtProjector.js";
import { PostCreateToAtProjector } from "./atproto/PostCreateToAtProjector.js";
import { PostDeleteToAtProjector } from "./atproto/PostDeleteToAtProjector.js";
import { PostEditToAtProjector } from "./atproto/PostEditToAtProjector.js";
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
