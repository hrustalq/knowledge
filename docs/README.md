# Documentation

Three sets of documents, each answering a different question:

- **[`../plan.md`](../plan.md)** — design intent. The architecture as decided and
  the phased execution plan. Authoritative for _what we set out to build_.
- **[`architecture/`](architecture/README.md)** — how the platform is actually
  built, one document per logic layer: entrypoints, persistence, ingestion, search,
  merge/review, auth, the generated client, events, the web shell. Where the code
  has diverged from `plan.md`, these say so.
- **[`features/`](#feature-documentation)** — the product layer, one document per
  feature. Each covers scope, API surface, data-model changes, frontend work and
  what was deliberately deferred.

Code-level conventions and gotchas live in [`../CLAUDE.md`](../CLAUDE.md).

**Process docs** sit beside these: [versioning.md](versioning.md) is the semver
policy — what the version number promises, and the expand/contract rule that makes
a rollback possible. [../CONTRIBUTING.md](../CONTRIBUTING.md) covers the branch
policy, commit format and the release runbook. Changelog entries follow
[templates/changelog-entry.md](templates/changelog-entry.md).

## Feature documentation

Features 01–17 come from the original list in [`../features.md`](../features.md);
18 onward were specified as the platform grew.

| #   | Feature                                                                                                | Doc                                                                    | Status                      |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------- |
| 1   | Full document view                                                                                     | [features/01-document-view.md](features/01-document-view.md)           | ✅ implemented              |
| 2   | Search widget with filters                                                                             | [features/02-search-widget.md](features/02-search-widget.md)           | ✅ implemented              |
| 3   | Editor (Confluence-like)                                                                               | [features/03-editor.md](features/03-editor.md)                         | ✅ MVP                      |
| 4   | Auto re-index of dependents + live updates                                                             | [features/04-dependent-reindex.md](features/04-dependent-reindex.md)   | ✅ implemented              |
| 5   | Revision viewer                                                                                        | [features/05-revision-viewer.md](features/05-revision-viewer.md)       | ✅ implemented              |
| 6   | Document graph view                                                                                    | [features/06-graph-view.md](features/06-graph-view.md)                 | ✅ implemented              |
| 7   | Categorization                                                                                         | [features/07-categorization.md](features/07-categorization.md)         | ✅ implemented              |
| 8   | Document nesting (directories)                                                                         | [features/08-nesting.md](features/08-nesting.md)                       | ✅ implemented              |
| 9   | AI assistant                                                                                           | [features/09-ai-assistant.md](features/09-ai-assistant.md)             | ✅ MVP                      |
| 10  | Activity feed                                                                                          | [features/10-activity-feed.md](features/10-activity-feed.md)           | ✅ implemented              |
| 11  | Projects (Workspace > Project > Document)                                                              | [features/11-projects.md](features/11-projects.md)                     | ✅ implemented              |
| 12  | AI settings (per-workspace)                                                                            | [features/12-ai-settings.md](features/12-ai-settings.md)               | ✅ implemented              |
| 13  | Review mode (annotate a merge request)                                                                 | [features/13-review-mode.md](features/13-review-mode.md)               | ✅ implemented              |
| 14  | Glossary                                                                                               | [features/14-glossary.md](features/14-glossary.md)                     | ✅ implemented              |
| 15  | Page comments                                                                                          | [features/15-page-comments.md](features/15-page-comments.md)           | ✅ implemented              |
| 16  | Document import                                                                                        | [features/16-import.md](features/16-import.md)                         | ✅ implemented              |
| 17  | Dynamic document workflows                                                                             | [features/17-workflows.md](features/17-workflows.md)                   | ✅ implemented              |
| 18  | Internationalization (en / ru)                                                                         | [features/18-i18n.md](features/18-i18n.md)                             | ✅ implemented              |
| 19  | Connectors                                                                                             | [features/19-connectors.md](features/19-connectors.md)                 | ✅ implemented              |
| 20  | Agents                                                                                                 | [features/20-agents.md](features/20-agents.md)                         | ✅ implemented              |
| 21  | Agent mentions in discussions                                                                          | [features/21-agent-mentions.md](features/21-agent-mentions.md)         | ✅ implemented              |
| 22  | Notifications                                                                                          | [features/22-notifications.md](features/22-notifications.md)           | ✅ implemented              |
| 23  | Faces and hover cards                                                                                  | [features/23-identity.md](features/23-identity.md)                     | ✅ implemented              |
| 24  | The project page                                                                                       | [features/24-project-page.md](features/24-project-page.md)             | ✅ implemented              |
| 25  | Web research                                                                                           | [features/25-web-research.md](features/25-web-research.md)             | ✅ implemented              |
| 26  | Connector staging                                                                                      | [features/26-connector-staging.md](features/26-connector-staging.md)   | ✅ implemented              |
| 27  | Comment editing, Comment vs. Start thread                                                              | [features/27-comment-editing.md](features/27-comment-editing.md)       | ✅ implemented              |
| 30  | GitHub repository picker                                                                               | [features/30-github-repo-picker.md](features/30-github-repo-picker.md) | ✅ implemented              |
| 31  | Code research                                                                                          | [features/31-code-research.md](features/31-code-research.md)           | ✅ implemented              |
| 32  | Tree drag-and-drop                                                                                     | [features/32-tree-drag-and-drop.md](features/32-tree-drag-and-drop.md) | ✅ implemented              |
| 33  | Connect AI (MCP over HTTP, API keys, skill)                                                            | [features/33-connect-ai.md](features/33-connect-ai.md)                 | ✅ implemented              |
| 34  | The editor's assistant                                                                                 | [features/34-editor-assistant.md](features/34-editor-assistant.md)     | ✅ implemented              |
| 35  | Drift check on pull / merge requests                                                                   | [features/35-pr-drift-check.md](features/35-pr-drift-check.md)         | ✅ implemented              |
| 36  | GitHub access and re-authorisation                                                                     | [features/36-github-access.md](features/36-github-access.md)           | ✅ implemented              |
| 37  | AI-readable output (llms.txt, `.md` pages)                                                             | [features/37-ai-readable-output.md](features/37-ai-readable-output.md) | ✅ implemented              |
| 38  | Answer provenance, confidence, verify stamp, votes                                                     | [features/38-answer-provenance.md](features/38-answer-provenance.md)   | ✅ #67 phases 1–5           |
| 39  | Page verification, ownership, freshness, archive                                                       | [features/39-page-verification.md](features/39-page-verification.md)   | ✅ #66                      |
| 40  | Knowledge health (dashboard API, bulk, settings)                                                       | [features/40-knowledge-health.md](features/40-knowledge-health.md)     | ✅ #66                      |
| 41  | Mail (verification, reset, invites, directed notifications)                                            | [features/41-mail.md](features/41-mail.md)                             | ✅ #132                     |
| 42  | Page templates (gallery, `/template`, AI fill, workflows, import)                                      | [features/42-page-templates.md](features/42-page-templates.md)         | ✅ #69                      |
| 43  | Share links (public read-only page/subtree, password, expiry, revoke)                                  | [features/43-share-links.md](features/43-share-links.md)               | ✅ #77 phase 1              |
| 44  | Published sites (docs site per project, snapshots, versions, theme, custom domains, sitemap, llms.txt) | [features/44-docs-portal.md](features/44-docs-portal.md)               | ✅ #77 phases 2a–3          |
| 45  | Export (page, subtree or project → ZIP of markdown, offline HTML, PDF via Gotenberg)                   | [features/45-export.md](features/45-export.md)                         | ✅ #77 phase 2c             |
| 46  | Repo wiki (wiki-shaped codebase connector, `.knowledge/wiki.yml` steering, diagrams, release notes)  | [features/46-repo-wiki.md](features/46-repo-wiki.md)                   | ✅ #72                      |
| 47  | Chat bots (Telegram and Time: cited Q&A as the linked person, ratings, save as draft, group notifications) | [features/47-chat-bots.md](features/47-chat-bots.md)                   | ✅ #71 phases 1–4           |
| 48  | Page permissions (restrictions, groups, guests, access requests, permission-aware retrieval, connector ACL mirroring) | [features/48-page-permissions.md](features/48-page-permissions.md)     | ✅ #76                      |
| 49  | Agent triggers (events, signed webhooks, mentions, time-of-day schedules, recipes, digest, learnings, repo guidance as skills) | [features/49-agent-triggers.md](features/49-agent-triggers.md)     | ✅ #70                      |
| 50  | Agent memory (capture tools, capture key scope, dedupe → merge request, captures inbox, MR provenance, capture kit for Claude Code and Cursor) | [features/50-agent-memory.md](features/50-agent-memory.md)         | ✅ #73                      |
| 51  | Component pages (`component:` declarations, reverse-import index, Used by, `code` edges, drift ties and Affected usages, Document this component, missing-paths health filter) | [features/51-component-pages.md](features/51-component-pages.md)   | ✅ #236                     |
| 52  | API reference (OpenAPI/AsyncAPI spec documents, operation entities, reference reader, code samples, try-it proxy, page linking, classified spec diff and breaking-change gate, repo sync, spec ↔ code drift) | [features/52-api-reference.md](features/52-api-reference.md)       | ✅ #78                      |
| 53  | Doc quality (styleguide per workspace/project, `linter` agent, merge request lint threads, `block` lint gate with admin override, `auditor` quality scores, Quality tab and rail, glossary from content) | [features/53-doc-quality.md](features/53-doc-quality.md)           | ✅ #74                      |
| 54  | Enterprise auth (OIDC, SAML and LDAP sign-in, JIT, group → role mapping, enforced SSO and verified domains, SCIM 2.0 provisioning, session list, back-channel logout, workspace audit log) | [features/54-enterprise-auth.md](features/54-enterprise-auth.md)   | ✅ #75                      |
| 56  | Real-time co-editing of drafts (Yjs + Hocuspocus, shared draft per branch, carets and presence, publish → ordinary revision, discard, branch drafts, shared assistant suggestions, offline copies) — behind `COLLAB_ENABLED` | [features/56-realtime-coediting.md](features/56-realtime-coediting.md) | ✅ #80 (flag off) |
| 57  | Temporal graph (valid and system time on every fact, `asOf` by date, revision or release tag across graph, entities, content, search and MCP; release tags; graph timeline and changes-since; contradictions from the arbiter and the sentinel; community summaries for broad questions) | [features/57-temporal-graph.md](features/57-temporal-graph.md) | ✅ #81 |
| 58  | Usage analytics (page reads and read time from the page's own beacon, every search and MCP tool call as an event row, human / assisted / agent on every number, page insights, project reading, unread and dead pages in knowledge health, the admin `/analytics` dashboard with CSV export, retention, and the `knowledge_get_page_insights` / `knowledge_list_search_gaps` tools) | [features/58-usage-analytics.md](features/58-usage-analytics.md) | ✅ #79 |
| 59  | Chat harvest (a Telegram or Time thread, asked for by `capture`, a DM's forwards, 📌 on Time or ✍ on Telegram, masked and proposed by the `harvester` as reviewed agent-memory captures with a server-set origin; Telegram's opt-in masked listening buffer and `/forget`; 💾 Save as a capture) | [features/59-chat-harvest.md](features/59-chat-harvest.md) | ✅ #82 |

Open work against the agents feature is tracked in
[features/20-agents-todo.md](features/20-agents-todo.md).
