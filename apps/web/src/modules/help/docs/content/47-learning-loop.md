---
title: Learning loop
section: Administration
summary: How the workspace's agents learn from what people do with their output — counted outcomes, proposed learnings an admin approves, and search settings tuned offline. Nothing is trained, and nothing changes without a person.
route: /knowledge-health
---

Agents make the same mistake again and again unless someone tells them. The learning
loop measures what happens to their output, drafts corrections from mistakes that keep
coming back, and proposes better search settings. **It never changes anything by itself.**
An admin approves every learning, and a person applies every setting.

## What became of each agent's output

**Knowledge health → Agents** (workspace admins) counts each agent's findings and the
votes on answers:

- **Accepted**: its proposal merged, or nobody dismissed the finding within 14 days. An
  upvoted answer counts as accepted too.
- **Dismissed**: a person dismissed the finding or closed its proposal.
- **Downvoted**: an answer someone voted down.
- **Pending**: everything still open.

**Split by** breaks an agent down by prompt or by model. That shows whether a skill edit
or a model change made things better. Below 20 runs a cell shows a count ("4 of 9"),
never a percentage, because a rate over nine runs is a guess.

Every run records the model it used, a fingerprint of its prompt (built only from text
your team wrote or approved, never from page content), and the learnings it was given.
Runs from before this feature show as *unattributed*.

## Learnings drafted from repeated dismissals

When the learner process is on, it looks once a day for findings that are **the same
mistake**: at least three findings from one agent, in one project, within 30 days,
dismissed by at least two different people. For each such group the `coach` agent drafts
one correction in general terms. It appears under **Settings → AI → Learnings** as a
*proposed* learning with a **Derived** badge and the findings it came from.

- **Read the evidence before approving.** No agent is told a derived learning until an
  admin approves it. Findings citing a page you cannot open count as "+N not visible to
  you", without titles.
- **Restricted pages never contribute.** A finding that cites a restricted page, or a page
  under one, is left out before anything is drafted.
- **One mistake, one learning.** A later similar dismissal is added to the existing
  learning's evidence instead of creating a new one. If you archived a learning, the
  same findings do not bring it back.
- **Hand-written learnings come first.** Derived learnings get at most half of an
  agent's learning budget and never push out one a person wrote.

**Learnings that did not help.** Once an active learning has 20 runs on each side of its
approval, the learner compares how often findings were dismissed before and after. If
dismissals did not drop, the learning is flagged *proposed for archiving*, with both
counts shown. Archive it, or press **Keep active**, and the learner will not ask again
until the learning is approved anew.

## Guidance for coding agents over MCP

A learning can teach **Agents over MCP (Claude Code, Cursor…)**. Once approved, it is
sent to every connected client in the server's instructions, and in `knowledge://skill`
under **Team guidance**. A key narrowed to some projects gets only those projects'
learnings, plus the workspace-wide ones. The learner also drafts MCP learnings from
captures people rejected, captured merge requests closed unmerged, and downvoted answers
built from `knowledge_search`. A capture dropped as a duplicate is not a failure, because
dedupe did its job.

## Search settings, tuned offline

**Knowledge health → Settings → Search ranking** has two knobs:

- **Fusion constant (RRF k)**: lower favours the single best match from either search,
  higher favours pages both searches found.
- **Trust weights**: what each page state multiplies a result's score by. They do
  nothing while trust-aware ranking is off.

Each knob shows what you asked for, what applies and the default. Empty means inherit,
and with nothing set, search ranks exactly as it always has. The capture thresholds
under **Settings → AI → Agent memory** work the same way.

An operator can run `make tune ARGS="--workspace <id>"` to get proposed values. It
replays the workspace's answer votes and its page titles against search, and proposes
a change only when it helps on both the cases it was tuned on and a held-out 30 %. It
also requires that known pages are not harder to find. It prints the exact settings
request to send and **writes nothing**. With no votes yet, the answer is "Nothing to
propose".

## Turning the learner on

The learner is a separate, optional process (the `learner` compose profile). An operator
starts it with `LEARNER_ENABLED=true`. Its thresholds are environment variables
(`LEARNER_WINDOW_DAYS`, `LEARNER_MIN_DISMISSALS`, `LEARNER_MIN_PEOPLE`,
`LEARNER_CLUSTER_THRESHOLD`, `LEARNER_MIN_RUNS`). At low volume a group of three may
take weeks to form. Until the learner is on, the counts on the Agents tab and
hand-written learnings still work.
