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

| #   | Feature                                    | Doc                                                                    | Status         |
| --- | ------------------------------------------ | ---------------------------------------------------------------------- | -------------- |
| 1   | Full document view                         | [features/01-document-view.md](features/01-document-view.md)           | ✅ implemented |
| 2   | Search widget with filters                 | [features/02-search-widget.md](features/02-search-widget.md)           | ✅ implemented |
| 3   | Editor (Confluence-like)                   | [features/03-editor.md](features/03-editor.md)                         | ✅ MVP         |
| 4   | Auto re-index of dependents + live updates | [features/04-dependent-reindex.md](features/04-dependent-reindex.md)   | ✅ implemented |
| 5   | Revision viewer                            | [features/05-revision-viewer.md](features/05-revision-viewer.md)       | ✅ implemented |
| 6   | Document graph view                        | [features/06-graph-view.md](features/06-graph-view.md)                 | ✅ implemented |
| 7   | Categorization                             | [features/07-categorization.md](features/07-categorization.md)         | ✅ implemented |
| 8   | Document nesting (directories)             | [features/08-nesting.md](features/08-nesting.md)                       | ✅ implemented |
| 9   | AI assistant                               | [features/09-ai-assistant.md](features/09-ai-assistant.md)             | ✅ MVP         |
| 10  | Activity feed                              | [features/10-activity-feed.md](features/10-activity-feed.md)           | ✅ implemented |
| 11  | Projects (Workspace > Project > Document)  | [features/11-projects.md](features/11-projects.md)                     | ✅ implemented |
| 12  | AI settings (per-workspace)                | [features/12-ai-settings.md](features/12-ai-settings.md)               | ✅ implemented |
| 13  | Review mode (annotate a merge request)     | [features/13-review-mode.md](features/13-review-mode.md)               | ✅ implemented |
| 14  | Glossary                                   | [features/14-glossary.md](features/14-glossary.md)                     | ✅ implemented |
| 15  | Page comments                              | [features/15-page-comments.md](features/15-page-comments.md)           | ✅ implemented |
| 16  | Document import                            | [features/16-import.md](features/16-import.md)                         | ✅ implemented |
| 17  | Dynamic document workflows                 | [features/17-workflows.md](features/17-workflows.md)                   | ✅ implemented |
| 18  | Internationalization (en / ru)             | [features/18-i18n.md](features/18-i18n.md)                             | ✅ implemented |
| 19  | Connectors                                 | [features/19-connectors.md](features/19-connectors.md)                 | ✅ implemented |
| 20  | Agents                                     | [features/20-agents.md](features/20-agents.md)                         | ✅ implemented |
| 21  | Agent mentions in discussions              | [features/21-agent-mentions.md](features/21-agent-mentions.md)         | ✅ implemented |
| 22  | Notifications                              | [features/22-notifications.md](features/22-notifications.md)           | ✅ implemented |
| 23  | Faces and hover cards                      | [features/23-identity.md](features/23-identity.md)                     | ✅ implemented |
| 24  | The project page                           | [features/24-project-page.md](features/24-project-page.md)             | ✅ implemented |
| 25  | Web research                               | [features/25-web-research.md](features/25-web-research.md)             | ✅ implemented |
| 26  | Connector staging                          | [features/26-connector-staging.md](features/26-connector-staging.md)   | ✅ implemented |
| 27  | Comment editing, Comment vs. Start thread  | [features/27-comment-editing.md](features/27-comment-editing.md)       | ✅ implemented |
| 30  | GitHub repository picker                   | [features/30-github-repo-picker.md](features/30-github-repo-picker.md) | ✅ implemented |
| 31  | Code research                              | [features/31-code-research.md](features/31-code-research.md)           | ✅ implemented |
| 32  | Tree drag-and-drop                         | [features/32-tree-drag-and-drop.md](features/32-tree-drag-and-drop.md) | ✅ implemented |

Open work against the agents feature is tracked in
[features/20-agents-todo.md](features/20-agents-todo.md).
