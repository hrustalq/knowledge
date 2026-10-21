# Knowledge platform

A versioned documentation store where people and agents write pages, and anything a model proposes becomes canonical only through a person's review.

## Capturing knowledge from chat

**Capture**:
One proposed piece of knowledge (a decision, gotcha, convention, how-to, glossary term, relation or answer) waiting for a person to accept it into the knowledge base.
_Avoid_: memory, suggestion, finding

**Harvest**:
A person's request that the platform read one chat thread and propose captures from what it settled.
_Avoid_: import, ingest, sync, capture run

**Thread**:
The messages one harvest reads: a Time root post with its replies, or a Telegram stretch of messages a person pointed at.
_Avoid_: conversation source, source item, document

**Listening**:
A chat binding's opt-in mode in which the bot briefly keeps group messages not addressed to it, so that a thread can be put back together for a harvest. What it keeps is never searchable.
_Avoid_: indexing, archiving, recording

**Origin**:
Where a capture came from: the chat, the thread and the time span of its messages.
_Avoid_: session (a session is a coding agent's working session), source

## Handing off work to trackers

**Work item** («Задача»):
One ticket in an external tracker as this platform records it: its key, status and the knowledge object it is about. A projection of the tracker, never the source of truth for the work.
_Avoid_: task (that is a workflow step), ticket row, task source

**Tracker** («Трекер»):
The external system that owns the work: Jira, GitHub Issues (with an org Projects board), GitLab Issues. It is the task list; the platform shows the link, never a second board.
_Avoid_: task source, issue source, board

**Handoff** («Передать в трекер»):
Creating a ticket for a knowledge object, or attaching an existing one to it, so that the work is tracked where the team tracks work and its status flows back.
_Avoid_: export, sync, escalation

**Anchor** («Привязка»):
The knowledge object a work item points at: a reported issue, a knowledge conflict, a page's verification flag, or a page. Always a row; a finding on an agent run becomes a reported issue before it can be one.
_Avoid_: link (a link maps external content onto a page), source, subject
