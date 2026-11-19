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

## Keeping pages in step with external sources

**Source-backed page** («Страница из источника»):
A read-only page whose body belongs to an external source (a web page, a tree of pages, an API spec) and is replaced by each new version of that source.
_Avoid_: referenced document, mirror, external page, linked page

**Dependent page** («Зависимая страница»):
A page that refers to a source-backed page — by a link, a relation or a shared entity — and so may stop being true when that source changes.
_Avoid_: referencing page, backlink, child page

**Extraction recipe** («Рецепт извлечения»):
The per-source description of where a source's content is and how to turn it into a page; when the source's shape changes, a person reviews a new recipe.
_Avoid_: parser, script, scraper

## Starting a project

**Blueprint** («Шаблон структуры»):
A reusable description of a project: a page tree (titles, categories, template or heading skeleton, guidance) plus the conventions it starts with — styleguide, project templates, glossary seed terms. Built-in, saved for a workspace, derived from an existing project, or drafted from a description. Scaffolding copies a plain blueprint; one that is a methodology is linked instead.
_Avoid_: template (that is one page), project template, scaffold, preset

**Methodology** («Методология»):
A blueprint that also declares levels, workflows or agents. A project links at most one, live (`projects.blueprint_id`): its templates, workflows, styleguide, glossary and agents resolve project → methodology → workspace, so editing the methodology changes every project that follows it. Linked, it can be switched off but not deleted. See docs/features/82.
_Avoid_: framework, process (a process is a page category)

**Level** («Уровень»):
One ordered stage of a methodology's work: L0 Intent to L7 Code, or question to decision. A page's level is derived from the template it was made from, never stored. In chat, a level picks the default agent and adds its guidance.
_Avoid_: layer (graph layers, docs/features/63, are a different axis), tier (a model's size class), stage

**Collection** («Коллекция»):
A page whose future children follow a rule: a child template and a numbered title pattern (`ADR {{n:4}}: `, `{{n:2}} — `), so "New page" under it starts as the next item. Any page can be one; it is not a page kind.
_Avoid_: folder, list, series, section

**Interview** («Интервью»):
Describe it's rounds of questions before a blueprint is drafted. The assistant asks what the description leaves open, a few questions at a time, each with a suggested answer, and looks facts up itself. It writes nothing; the answers shape the draft.
_Avoid_: flow (that is a code-defined question sequence that writes), wizard, questionnaire, Q&A

**Scaffold stub** («Незаполненная страница»):
A page whose head is still the revision the scaffold wrote. It is in the tree for people to fill in, but kept out of search, Ask, llms.txt and the health counts until its first real edit.
_Avoid_: draft (that is a private page or branch), template (in the ru UI «заготовка» already means a page template), placeholder page

## The relation graph

**Entity** («Сущность»):
A thing the graph knows, held as one vertex per canonical entity key. Pages point at entities through relations; there is no page-to-page edge.
_Avoid_: object, node (pages are nodes too), concept (`concept` is a layer)

**Entity key** («Ключ сущности»):
An entity's identity, written `type:name` (`service:identity`) and folded to one canonical spelling. Two spellings of one entity are joined by an entity alias, not a glossary term.
_Avoid_: id, slug

**Entity type** («Тип сущности»):
The prefix of an entity key: `service` in `service:identity`. Any prefix is accepted and none is registered; some also place the entity on a layer. See docs/architecture/14.
_Avoid_: class, kind (a document's kind is openapi or asyncapi), category (that is a page's)

**Relation type** («Тип связи»):
One of the fixed set of edge types a page may declare towards an entity: `DESCRIBES`, `DEPENDS_ON`, `IMPLEMENTS`, `RELATED_TO`, `OWNED_BY`, `SUPERSEDES`, `CONTRADICTS`; `TAGGED_WITH` comes from tags only.
_Avoid_: link (a link maps external content onto a page), predicate, property

**Ontology** («Онтология»):
Only the L1 level of the construction methodology: a team's own domain model, documented as one entity page per domain entity with the words in the glossary. The graph's entity and relation types are not called an ontology, because nothing enforces which relation may join which types. See docs/architecture/14.
_Avoid_: using it for the graph's types; schema (that is Prisma or OpenAPI); taxonomy
