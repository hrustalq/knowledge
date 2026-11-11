# 75 — Memo sorting: types, triage, tags and who is speaking

Issues: [#879](https://github.com/hrustalq/knowledge/issues/879) (types, triage, tags),
[#880](https://github.com/hrustalq/knowledge/issues/880) (speakers), [#878](https://github.com/hrustalq/knowledge/issues/878)
(speaker separation). PRs #888, #889, #890, #891 and the one that added this record. The mechanics of each part
are written where the code lives, in [68 — Memos](68-memos.md); this page is the map and the rules.

## What

Before the `secretary` reads a memo, the memo can be **sorted**: what kind of recording it is, which project it
belongs to, what it is about, and who is speaking. Each of those changes what the secretary is told, and none
of them changes what it is allowed to touch.

```
transcript (ours with numbered voices, or Plaud's with names)
  → MemoTriageSweeper (API, as the uploader): one model call → type, project, tags, speaker guesses
      → type marked auto  → applied, moved to the type's project → secretary
      → anything else     → status `review`, notification → the owner confirms → secretary
  → secretary: instructions + the type's guidance + "<label> is <name>" for speakers that are matched
```

| Part | Setting | Off means |
| --- | --- | --- |
| Voices told apart in our own transcripts | `TRANSCRIPTION_SPEAKERS` (gen-api only) | text only, as before |
| Triage and the `review` state | `MEMO_TRIAGE_ENABLED` | straight to analysis, as before |
| Types, tags by hand, speaker matching by hand | none | always available |

## The rules

- **A type's guidance is trusted text; everything a model says is not.** Guidance is written by a workspace
  admin and joins the secretary's system instructions. A type the model proposes (`triage.newType`) is stored on
  the memo and shown; it becomes a type only when an admin presses "Add this type", which is an ordinary
  `PUT /v1/memos/types/:key`.
- **A suggestion names only what the uploader may use.** Triage is shown the workspace's offered types and the
  projects that pass `PermissionService.requireLevel` under the uploader's scope at that moment. `readTriage`
  drops anything that was not on that list rather than looking it up.
- **Nothing is applied without the owner, except what an admin opted into.** `triageApplies` is true only for a
  type whose row has `auto`. Everything else waits in `review` for `POST /v1/memos/:id/confirm`.
- **Triage fails open.** A memo is never stuck behind it: no model, no budget, an error or an unreadable answer
  sends it on unsorted.
- **A speaker match is the uploader's statement, and a guess is only a guess.** `resolveSpeakers` separates a
  match that holds (`confirmed`, `remembered`) from `suggestedUserId`. Guesses come from the label (one member
  with that name) and from triage (the conversation itself makes clear who a speaker is, and the name it gives
  belongs to exactly one member). Only matches that hold reach the secretary. A numbered voice (`Speaker 1`) is
  never remembered across memos.
- **Being named grants nothing.** A matched person gains no access to the memo and is not notified. A memo is
  still read only through `MemosService.require`.
- **None of this widens the secretary.** Which pages a memo may update is still `readMemoProposals`: retrieved
  by the run's own tools, visible to the uploader, resting on cited segments.
- **Promises kept from doc 74.** Nothing of a Plaud recording is read before it becomes a memo, and Plaud's own
  name for a recording never reaches a model: triage runs on the memo, after import.

## Data

| Where | What |
| --- | --- |
| `memo_types` | a workspace's sparse edits to the built-in catalogue: `name`, `guidance`, `hidden`, `project_id`, `auto` |
| `memos.type`, `memos.tags` | the memo's type key and its topic tags (string array, cleaned by `cleanTags`) |
| `memos.triage`, `memos.triaged_at` | the stored suggestion (`MemoTriage`) and the sweeper's lease |
| `memos.speakers` | `{ label: userId \| null }`, the uploader's matches |

Classifiers stay derived: a memo's progress (`memoProgressFor`), who a speaker is (`resolveSpeakers`) and the
effective catalogue (`effectiveMemoTypes`) are all computed on read from these rows.

## Surfaces

- `/memos`: type and tags on each row, a type filter and a tag filter, "Memo types" for admins.
- A memo's page: the type select, the Speakers section, tags in the meta row and under ⋮ "Edit tags", and while
  the memo waits, the "Confirm this memo" panel with the suggestion pre-filled.
- Notifications: `memo.review` to the uploader when their memo starts waiting.
- Usage: `memo-triage`, one row per sorted memo, on the secretary's model.

## Not built

- A type's target page or page template: guidance text only, by the owner's decision for the first version.
- Re-running the secretary after a type, a tag or a speaker changes on a memo already analysed.
- Matching voices across the hourly pieces of a recording longer than an hour (doc 68, `ponytail:` in
  `stitchTranscript`).
- Sorting recordings while they are still in the Plaud queue: by decision, see the promises above.
