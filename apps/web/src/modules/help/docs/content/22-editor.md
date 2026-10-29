---
title: The editor
section: Using the app
summary: WYSIWYG that round-trips through markdown, and the rule every rich block obeys.
route: /create · /documents/:id/edit
---

A rich editor whose document model is markdown. Everything you can insert serializes to
markdown and parses back identically — that round trip is the contract, not a
nice-to-have, because the markdown is what gets chunked, embedded and searched.

## The rule for rich blocks

**Every rich block must keep its prose indexable.** A block that renders as an opaque
widget would be invisible to search, so each one maps onto markdown that still contains
its words:

| Block | Serializes to |
| --- | --- |
| Panels / callouts | GitHub alert syntax — `> [!NOTE]` |
| Expandable sections | `<details>` / `<summary>` |
| Diagrams | a ` ```mermaid ` fence — the source is text |
| Tables, lists, code | ordinary markdown |
| Attachments | a link with the file's metadata |

Whiteboard scenes and PDF frames are the exception that proves it: they carry their own
data, and the surrounding prose is what search sees.

## Frontmatter and relations

The editor has a frontmatter panel: title, tags, category, and the **relations** list.
Relations added here are written into the page's frontmatter and become deterministic
graph edges when it indexes — confidence 1, no model involved. This is the reliable way
to say *this page describes that service* or *this depends on that*.

## Attachments

Files are uploaded straight to object storage with a presigned URL — the same mechanism
the page body uses — and the editor inserts a link once the upload lands.

## Saving

Save creates a new revision. If someone else advanced the branch while you were writing,
the save is refused with a conflict and a link to compare, rather than quietly winning.

## Diagrams

Mermaid renders live in the preview and on the read side. Since the fence holds the
diagram's source, a diagram's labels are searchable text.
