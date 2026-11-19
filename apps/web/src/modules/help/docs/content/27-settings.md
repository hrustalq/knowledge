---
title: The settings sections
section: Using the app
summary: What each section under Settings is for, and which role it needs.
route: /settings
---

| Section | For | Needs |
| --- | --- | --- |
| **Projects** | create, rename and delete projects; the roster rail plus one project's settings | `viewer` to read, `editor` to change, `admin` to delete |
| **Glossary** | the project's vocabulary — terms, aliases, definitions, and AI-proposed candidates | `viewer` / `editor` |
| **Users** | platform accounts: create, disable, grant platform admin | platform admin |
| **Access** | workspace membership and roles | `viewer` to see, `admin` to change |
| **Activity** | the workspace timeline — who changed what | `viewer` |
| **AI** | providers, agents, skills, MCP plugins, budgets, usage and the call log | workspace `admin` |
| **Workflows** | workflow definitions, on a drag-and-drop canvas | workspace `admin` |
| **Connectors** | external systems, their runs and their links | workspace `admin` |
| **Docs** | this documentation | anyone |

Two of these are easy to confuse:

- **Activity** is the product timeline — page created, MR merged, comment resolved. It is
  what a team reads.
- The **audit log** (Security → Audit log, `GET /v1/audit-logs`) records administration:
  members and roles, sections, publishing, API keys, AI settings, connectors, templates,
  workflows and the glossary, plus sign-ins, access changes, operator graph queries and
  exports. It is admin-only and filters by category, action, actor, subject, dates and
  outcome. **Export** downloads the filtered set as CSV or JSON, and the download is
  recorded too. It is what a security review reads.

Sections gate themselves on the role rather than on the route, because these are workspace
permissions and the API enforces them regardless. The one exception is **Users**, which is
a platform-level concern and redirects a non-admin to `/403` before the page loads.
