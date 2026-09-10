# 24 — The project page

There was nowhere to see what a project *was*. `/settings/projects/:id` is a
form — two inputs and a delete button — and the sidebar knew a name and a page
count. A project holds the pages, the glossary, the connectors and most of the
work, and none of that had a home. `projects.description` had existed since
feature 11 and was displayed on no screen at all.

`/projects/:id` is the read side; `/settings/projects/:id` stays the form.

## Shaped like the document page

Feature 15's rail, deliberately reused: the main column is the thing itself
(what the project is for, and what has been written in it), and every fact
*about* it lives in a stack of collapsible widgets — Overview, People, Activity,
Changes, Glossary, Connectors, Workflows — each folded to the one number that
decides whether to open it. Two pages answering "what is this" should not have to
be learned twice.

`?tab=` is an *opening* instruction rather than two-way state, the same contract,
because several widgets can be open at once. A widget with nothing in it is
filtered out entirely: the reader learns "no connectors" from its absence just as
well, and without a row to skip. Overview and People always show — "nobody has
written anything here yet" is the useful thing to say about an empty project.

## People are derived, never assigned

Projects hold no members and are not getting any. Feature 11's *"organizational
only"* stands: a second ACL layer under the workspace boundary would be a new
authorization surface to get right, for no gain.

So the People widget is not a membership list. It is the people who have actually
revised a page in this project — documents carry no author column, so authorship
comes from `document_revisions.author_id`, the same derivation
`ProfilesService.pagesFor` makes in the other direction. It has the useful
property of staying true with nobody maintaining it, and the widget says so in a
caption: a list of faces otherwise reads as an access list, and nothing here
grants anything.

Ids only. Names and faces come from the member roster the client already has
cached, so the endpoint never sends a second copy that can disagree.

Sorted by page count, then recency: the question a reader is asking is "who
should I ask about this", which is closer to volume than to whoever fixed a typo
this morning.

`GET /v1/projects/:id/overview` is modelled directly on `ProfilesService` — one
`Promise.all` of counts over rows that already exist, no stored table, because a
cached copy would only be a second answer to the same question. It lives in
`ProjectOverviewService` rather than `ProjectsService`, which is in
`ProjectsCoreModule` because the worker needs `requireProjectInWorkspace` and
none of this belongs in a worker.

## Activity needed one column

`activity_log` had no project reference, so there was no project feed to render
at all. It gained `project_id` (nullable, `@@index([projectId, createdAt])`),
denormalized at write time: the question a project page asks — newest first,
paged — is an index scan with the column and a join through every page the
project owns without it.

**The migration backfills history**, from `documents.project_id` for rows about a
page and from `subject_id` for `project.*` rows. A feed that starts empty on the
day the column shipped is not a feed. (A page that has since moved projects reads
as having always lived where it lives — wrong in principle, but `activity_log`
stored no project at write time and inventing one is worse than following the
page.) Written with `prisma migrate dev --create-only` and hand-edited SQL, the
`20260907160044_projects_layer` worked example.

Going forward `ActivityService.record` resolves it from `document_id` with one
indexed point-select when the caller does not supply it. That path is already
fire-and-forget and already writing a row; callers holding the document pass
`projectId` and skip even that. Resolving centrally rather than at ~30 call sites
also means a new one cannot forget — a row filed under no project is invisible on
the page that exists to show it.

## Customization

`description` already existed and now renders as markdown on the page (the field
has always accepted it, and people write links in it). The face is feature 23's
`ProjectAvatar` — picture, emoji, or monogram — with the picker and a short
emoji row on the settings form. Both save on their own: an upload has already
happened by the time it returns, and an emoji is one click, so pairing either
with the name's **Save** button would claim otherwise.

The emoji row is a dozen options, not a full picker. A picker is a searchable
grid of two thousand glyphs, and the decision here is "which of these reads as my
project at 20px" — a question a short domain-shaped list answers faster than a
search box. Anything else still goes through the field, which accepts any emoji
the API validates.

## Files

| | |
|---|---|
| Endpoint | `apps/api/src/projects/project-overview.service.ts`, `GET /v1/projects/:id/overview` |
| Activity | `activity_log.project_id` + backfill; `projectId` on the filter, DTO and `ActivityFeed.vue` |
| Page | `apps/web/src/pages/ProjectOverviewPage.vue`, route `/projects/:id` |
| Face | `components/projects/ProjectAvatar.vue`, used by `SidebarProjectsPane` and both project pages |
| Trail | `AppBreadcrumbs.vue` — roster, then project, pointed at the read side |
