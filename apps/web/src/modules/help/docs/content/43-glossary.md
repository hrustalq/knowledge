---
title: Glossary
section: Administration
summary: Project-scoped vocabulary, linked into pages at read time so no page is ever rewritten.
route: /settings/glossary
---

Terms are **project-scoped**: unique per `(project, term)`, so the same word can mean
different things in two projects — which is usually the actual situation.

Each term has aliases, a markdown definition, and optionally a page it points at.

## Two layers, same split as relations

**Linking is deterministic and happens at read time.** When a page renders, terms are
matched whole-word and case-insensitively, longest term first, skipping code, headings,
links and existing marks, at most three links per term per page. Word boundaries are
spelled out explicitly rather than using `\b`, which breaks on `.env` and `C++`.

**No page is ever rewritten.** The glossary is a rendering pass, so changing a definition
changes every page that mentions the term, and removing a term removes the links — with no
revisions created and no diffs generated.

**The LLM is only for authoring.** `POST /v1/glossary/suggest` proposes terms from a page
and persists nothing. Occurrences are counted server-side against the real source text and
ungrounded proposals are dropped, so a model cannot invent a term that does not appear.

## Where links appear

On page content and in review mode. Deliberately **not** in comment bodies or assistant
replies — vocabulary links belong in documentation, not in a chat log.

## Building one

The **Build glossary** action in the assistant proposes terms across a page or project and
renders them in the transcript with a per-term **Add**. Nothing is written until you press
it.
