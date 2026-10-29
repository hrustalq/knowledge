---
title: Import
section: Using the app
summary: A three-step wizard over a real file, seven parsers, and why every one of them reports what it could not carry.
route: /upload
---

Three steps: **Destination · Parse · Review**.

1. **Destination** — drop the file, choose the project, parent page and category.
2. **Parse** — the file uploads (a real progress ring, fed by actual upload bytes), then a
   worker parses it while the ring sweeps. Parsing is a background job the page polls, not
   an HTTP request: a 300-page PDF outlasts any timeout, and closing the tab must not lose
   the work.
3. **Review** — the parsed markdown in the same editor you write in, with a rail listing
   provenance and **warnings**. Fix it here, then submit.

## The parsers

| Format | What it does |
| --- | --- |
| **PDF** | reconstructs headings from font-size rank, drops repeating running heads, breaks paragraphs on vertical gaps; flags scans as needing OCR |
| **DOCX** | style-mapped headings, images lifted to attachments, glyph bullets turned back into lists |
| **PPTX** | one section per slide, outline levels preserved, per-slide images, speaker notes as quotes |
| **HTML** | converted to markdown |
| **CSV / tabular** | rendered as tables |
| **JSON / YAML** | kept as structured blocks |
| **Plain text / markdown** | markdown passes through untouched |
| **OCR** | scanned pages through the workspace's vision model — transcribe, never summarize |

## Warnings are the feature

Every parser returns what it **could not** carry, and the review step shows it: a
Confluence macro that has no markdown equivalent, a PowerPoint animation, a PDF table that
came through as text. A lossy import that says nothing is exactly the failure this flow
exists to prevent — you cannot fix damage you were never told about.

## Submit

One server-side call does the rest: creates the document, promotes the original file and
every extracted image into attachments, rewrites the staged image links to their permanent
URLs, then writes the markdown and finalizes. The result is **one revision whose image
links have always worked** — never a first revision pointing at temporary URLs.

The original file stays attached, so the source of an imported page is always recoverable.
