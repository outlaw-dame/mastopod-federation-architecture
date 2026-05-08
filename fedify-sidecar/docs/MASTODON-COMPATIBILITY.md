# Mastodon Compatibility Notes

This project keeps ActivityPods as the authority for user data, permissions, and Pod state. Mastodon-compatible API
surfaces should follow Mastodon field names at the edge, then map into the narrower internal vocabulary used by the
sidecar and ActivityPods runtime.

## Server Domain Moderation

Mastodon's provider/admin domain block model uses a `severity` field:

- `noop`: record the domain entry without changing delivery.
- `silence`: limit the server. In this architecture, that maps to the internal ActivityPub subject-policy `filter`
  action. Delivery to ActivityPods continues, but public surfacing and bridge projections are suppressed.
- `suspend`: block the server. In this architecture, that maps to the internal ActivityPub subject-policy `reject`
  action. Inbound delivery is stopped before ActivityPods forwarding.

Do not expose provider server-domain moderation as a generic "filter" field in Mastodon-facing UI or API contracts.
`filter` remains an internal enforcement action behind `silence`.

User-owned server rules are separate Pod settings. A Pod owner may limit or block a server for their own views, but this
does not override provider policy. Provider `suspend` and `silence` are upper-bound safety decisions for federation
delivery and public surfacing.

## Post Visibility

Mastodon status visibility values are:

- `public`
- `unlisted`
- `private`
- `direct`

Our canonical bridge vocabulary uses `followers` for Mastodon's `private` status visibility because the ActivityPub
addressing target is the actor's followers collection. Edge APIs that claim Mastodon compatibility should accept and
return `private`, then map it internally:

| Mastodon API | Internal Canonical | ActivityPub Addressing |
| --- | --- | --- |
| `public` | `public` | Public in `to`, followers in `cc` |
| `unlisted` | `unlisted` | followers in `to`, Public in `cc` |
| `private` | `followers` | followers in `to`, no Public recipient |
| `direct` | `direct` | explicit recipients only, no Public/followers broadcast |

Do not use Mastodon's `private` label to mean "only me." In Mastodon convention, `private` means followers-only.

## References

- Mastodon admin domain blocks: https://docs.joinmastodon.org/methods/admin/domain_blocks/
- Mastodon user domain blocks: https://docs.joinmastodon.org/methods/domain_blocks/
- Mastodon status APIs: https://docs.joinmastodon.org/methods/statuses/
