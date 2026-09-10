# 23 — Faces and hover cards

Two halves of one problem: the product rendered identities it could not
describe.

`lib/avatar.ts` said so in its own header — *"the product has no avatar
storage"* — and the global activity feed did not get even that far. It printed
`e.actor.slice(0, 8)`: eight characters of a UUID, where a person's name belongs.

## Avatars

The three-step upload page attachments already use (feature 16's rule: check
before the bytes move), for the same reason — a 2 MB image never streams through
Node.

```
POST /v1/me/avatar          → { uploadId, upload: { url, method: 'PUT', … } }
PUT  <presigned>            → the bytes, straight to storage
POST /v1/me/avatar/complete → headObject confirms, then the row switches
GET  /v1/users/:id/avatar   → 302 to a short-lived signed URL
```

`headObject` is not ceremony: the PUT goes straight to object storage, so the
API never saw whether it succeeded, and the size is re-checked against what
actually arrived rather than what the caller claimed. The old object is deleted
*after* the row moves, never before — until then it is still the live face and a
reader mid-request is entitled to it.

Reads are a redirect because `<img>` cannot send an `Authorization` header. The
API authorizes (AuthGuard already accepts `?token=`, the SSE mechanism) and hands
the browser a URL it can fetch directly. Disposition and content type are decided
server-side, so an upload can never talk the browser into treating it as
something executable — the attachments rule.

**Storage layout** is `avatars/{users|projects}/{id}/{uploadId}/{file}`,
deliberately outside the `workspaces/` tree everything else lives under: a person
belongs to several workspaces and a face does not change between them.

**`avatarUrl`** is always a bare `/v1/...` path with a `?v=<avatarUpdatedAt>`
stamp, resolved through the existing `resolveAssetUrl()`. The stamp is what
makes a replacement visible: keys are reused, and the person who just changed
their picture is the one most certain the app is broken.

`/v1/users/:id/avatar` is not `@Access`-guarded, because there is no single
workspace to resolve — a user belongs to several and the question is whether the
caller shares *any*. `assertCanSeeUser` answers that in one indexed query:
yourself, a platform admin, or someone you actually share a workspace with. "Any
authenticated caller" would have let one tenant enumerate another's people by id.

The dev principal has no `users` row, so `/v1/me/avatar` refuses — the wall
`POST /v1/me/api-key` already hits, refused the same way.

### Projects get an emoji too

A project tile renders at 20px in the sidebar, where an emoji stays crisp and a
downscaled screenshot turns to mud — and picking one is two clicks against
finding, cropping and uploading an image. So `projects` carries `avatar_key`,
`avatar_emoji` and `avatar_color`, and exactly one is ever set: uploading retires
the emoji, choosing an emoji retires the picture. Two at once would leave every
renderer choosing, and choosing differently in different places.

`ProjectAvatar.vue` is the one component that resolves picture → emoji →
monogram, so a project cannot look like a photograph in the sidebar and like
initials on its own page.

### Fallbacks are not placeholders

Initials on a stable per-user hue (`lib/avatar.ts`) and the two-letter monogram
for scopes (`lib/monogram.ts`) are the normal state, not a gap waiting to be
filled. Most people never upload anything, and "no picture" still has to read as
*someone in particular* — the hue is what makes a tile the thing you recognise
before you have read the label.

## Hover cards

`UserChip.vue` replaces the twenty-five hand-spelled `<UserAvatar>` +
`{{ nameOf(id) }}` pairs. One component means a face, a name and a way to find
out who that is arrive together everywhere — including the four places that had
no face and no name at all:

- `ActivityFeed.vue` — the truncated-UUID defect above.
- `MergeRequestDetailPage.vue` — `actorLabel(mr.authorId)`, same shape.
- `AdminUsersPage.vue`, `AccessControlPage.vue` — plain text, no face, no link.

**Data arrives in two layers.** The workspace-member roster is already a cached
vue-query (`useMembers`), so name, email, role and disabled state cost nothing
and the card is never empty on open. `GET /v1/profiles/:userId` fills in
membership and workload — and runs **only when a card opens**, gated by an
`enabled` flag. It is five queries server-side; firing it per row of a member
list would be a stampede for something nobody asked to see.

**Hover is not available everywhere.** A hover card on a touch device is a card
nobody can open, so the trigger carries both: `HoverCard` under `(hover: hover)`,
`Popover` otherwise — the two-surface split `ui/popover/ResponsivePopover.vue`
already makes. `useMediaQuery` reads false during SSR, which is the popover
branch; both are closed at hydration and the trigger markup is identical, so
there is nothing to mismatch.

### Where a chip is *not* used

- **Picker rows** in `MrSidebar` keep a plain `UserAvatar`: they live inside
  `<button>`s, and a link or button nested in a button is invalid markup that
  breaks the control it sits in.
- **Comment anchors** (`extensions/comment-anchors.ts`) build their face with
  plain DOM inside a ProseMirror decoration and cannot mount a Vue component.
- **Agents** get a chip with no card. There is no profile behind an agent, and
  offering one that resolves to nobody is worse than not offering it.

## Files

| | |
|---|---|
| Service + routes | `apps/api/src/avatars/` |
| URL shape | `apps/api/src/common/avatar-url.ts` (`userAvatarUrl`, `projectAvatarUrl`) |
| Key layout | `StorageService.avatarObjectKey` |
| Upload | `components/people/use-avatar-upload.ts`, `AvatarPicker.vue` (shares `lib/presigned-put.ts`) |
| Identity | `components/people/UserChip.vue`, `UserCard.vue`, `projects/ProjectAvatar.vue` |

`avatarUrl` is carried on `Principal` because three separate places answer
`GET /v1/me` from one, and the topbar avatar is the first thing rendered on every
page.
