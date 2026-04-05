import { FollowAddToApProjector } from "./activitypub/FollowAddToApProjector.js";
import { FollowRemoveToApProjector } from "./activitypub/FollowRemoveToApProjector.js";
import { PostCreateToApProjector } from "./activitypub/PostCreateToApProjector.js";
import { PostDeleteToApProjector } from "./activitypub/PostDeleteToApProjector.js";
import { PostEditToApProjector } from "./activitypub/PostEditToApProjector.js";
import { ProfileUpdateToApProjector } from "./activitypub/ProfileUpdateToApProjector.js";
import { ReactionAddToApProjector } from "./activitypub/ReactionAddToApProjector.js";
import { ReactionRemoveToApProjector } from "./activitypub/ReactionRemoveToApProjector.js";
import { ShareAddToApProjector } from "./activitypub/ShareAddToApProjector.js";
import { ShareRemoveToApProjector } from "./activitypub/ShareRemoveToApProjector.js";
import type { ActivityPubProjectionPolicy } from "./activitypub/ActivityPubProjectionPolicy.js";
import { ProjectorRegistry } from "../registry/ProjectorRegistry.js";
import type { ActivityPubProjectionCommand } from "../ports/ProtocolBridgePorts.js";

export class CanonicalToActivityPubProjector extends ProjectorRegistry<ActivityPubProjectionCommand> {
  public constructor(policy?: ActivityPubProjectionPolicy) {
    super([
      new PostCreateToApProjector(policy),
      new PostEditToApProjector(policy),
      new PostDeleteToApProjector(),
      new ProfileUpdateToApProjector(),
      new ReactionAddToApProjector(),
      new ReactionRemoveToApProjector(),
      new ShareAddToApProjector(),
      new ShareRemoveToApProjector(),
      new FollowAddToApProjector(),
      new FollowRemoveToApProjector(),
    ]);
  }
}
