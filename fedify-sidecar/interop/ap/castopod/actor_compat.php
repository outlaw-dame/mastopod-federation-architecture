<?php

declare(strict_types=1);

/**
 * Castopod 1.9.0 interop compatibility shim for remote actor materialization.
 *
 * Loaded with PHP auto_prepend_file before Castopod's guarded helper file, so
 * only create_actor_from_uri() is replaced. The stock helper assumes every
 * remote actor has display `name` and embedded `publicKey.publicKeyPem` fields.
 * ActivityPub does not require a display name, and ActivityPods exposes the
 * signing PEM at the standalone key resource addressed by keyId. Keep the
 * canonical actor fields strict while accepting those optional shapes.
 */

if (! function_exists('create_actor_from_uri')) {
    function create_actor_from_uri(string $actorUri): ?\Modules\Fediverse\Entities\Actor
    {
        $activityRequest = new \Modules\Fediverse\ActivityRequest($actorUri);
        $actorResponse = $activityRequest->get();
        $actorPayload = json_decode($actorResponse->getBody(), false, 512, JSON_THROW_ON_ERROR);

        if (
            ! isset($actorPayload->id, $actorPayload->preferredUsername, $actorPayload->inbox)
            || ! is_string($actorPayload->id)
            || ! is_string($actorPayload->preferredUsername)
            || ! is_string($actorPayload->inbox)
            || $actorPayload->id === ''
            || $actorPayload->preferredUsername === ''
            || $actorPayload->inbox === ''
        ) {
            return null;
        }

        $newActor = new \Modules\Fediverse\Entities\Actor();
        $newActor->uri = $actorPayload->id;
        $newActor->username = $actorPayload->preferredUsername;
        $newActor->domain = $activityRequest->getDomain();
        $newActor->public_key = isset($actorPayload->publicKey->publicKeyPem)
            && is_string($actorPayload->publicKey->publicKeyPem)
            ? $actorPayload->publicKey->publicKeyPem
            : null;
        $newActor->private_key = null;
        $newActor->display_name = isset($actorPayload->name) && is_string($actorPayload->name)
            && $actorPayload->name !== ''
            ? $actorPayload->name
            : $actorPayload->preferredUsername;
        $newActor->summary = isset($actorPayload->summary) && is_string($actorPayload->summary)
            ? $actorPayload->summary
            : null;

        if (isset($actorPayload->icon->url) && is_string($actorPayload->icon->url)) {
            $newActor->avatar_image_url = $actorPayload->icon->url;

            if (isset($actorPayload->icon->mediaType) && is_string($actorPayload->icon->mediaType)) {
                $newActor->avatar_image_mimetype = $actorPayload->icon->mediaType;
            } else {
                $iconExtension = pathinfo($actorPayload->icon->url, PATHINFO_EXTENSION);
                $newActor->avatar_image_mimetype = (string) \Config\Mimes::guessTypeFromExtension($iconExtension);
            }
        }

        if (isset($actorPayload->image->url) && is_string($actorPayload->image->url)) {
            $newActor->cover_image_url = $actorPayload->image->url;

            if (isset($actorPayload->image->mediaType) && is_string($actorPayload->image->mediaType)) {
                $newActor->cover_image_mimetype = $actorPayload->image->mediaType;
            } else {
                $coverExtension = pathinfo($actorPayload->image->url, PATHINFO_EXTENSION);
                $newActor->cover_image_mimetype = (string) \Config\Mimes::guessTypeFromExtension($coverExtension);
            }
        }

        $newActor->inbox_url = $actorPayload->inbox;
        $newActor->outbox_url = isset($actorPayload->outbox) && is_string($actorPayload->outbox)
            ? $actorPayload->outbox
            : null;
        $newActor->followers_url = isset($actorPayload->followers) && is_string($actorPayload->followers)
            ? $actorPayload->followers
            : null;

        if (! ($newActorId = model('ActorModel', false)->insert($newActor, true))) {
            return null;
        }

        $newActor->id = $newActorId;
        return $newActor;
    }
}
