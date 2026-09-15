# Changelog entry template

Copy the sections you need into `CHANGELOG.md` under `## [Unreleased]`, **in the
pull request that makes the change**. Writing entries at release time means
writing them from `git log`, which is how "Update dependencies and refactor
application modules" ends up in front of a reader.

Omit any section that is empty. Never leave an empty heading behind.

## The block

```markdown
## [Unreleased]

### Breaking

- <What a consumer must now do differently, in the imperative.> `<surface>`
  **Migration:** <the exact change they make on their side.>

### Added

- <A capability that did not exist.> (#PR)

### Changed

- <Existing behaviour that now behaves differently, but still works.> (#PR)

### Deprecated

- <Still works, will be removed in <version>. Say what replaces it.> (#PR)

### Removed

- <Gone. Pair with a Breaking entry unless it was never public.> (#PR)

### Fixed

- <The symptom a user saw, not the patch you wrote.> (#PR)

### Security

- <Only what a reader must act on. No exploit detail.> (#PR)

### Operations

- <Anything the person deploying must do or know: new env vars, migrations that
  cannot be rolled back, manual backfills, infra that must exist first.>
```

## Section rules

**Breaking** and **Operations** are not in Keep a Changelog; this project adds
them because its two real failure modes are a consumer whose client stops
compiling and an operator whose boot fails on a missing env var.

- **Breaking** — one entry per consumer-visible break, each naming the surface
  (`HTTP`, `MCP`, `config`, `events`) and carrying a **Migration:** line. If you
  cannot write the migration line, the change is not ready.
- **Operations** — required whenever the release adds an env var, ships a
  migration that is not reversible under the expand/contract rule, or needs a
  manual step. A release with a migration and no Operations entry is a release
  whose rollback nobody has thought about. See
  [versioning.md](../versioning.md#rollback-and-the-expandcontract-rule).

## Write for the reader, not the author

The reader is operating or consuming the system, and does not know the code.

| Don't                               | Do                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Refactor MergeRequestsService`     | _(nothing — a pure refactor is not notable)_                                                                                  |
| `Fix bug in search`                 | `Search no longer drops results whose title is Cyrillic.`                                                                     |
| `Add projectId to search filters`   | `Search can be scoped to one project via \`filters.projectIds\`.`                                                             |
| `Update AI settings`                | `Per-workspace AI provider profiles can now be routed per purpose (chat/review).`                                             |
| `BREAKING: change content endpoint` | `\`GET /v1/documents/:id/content\` no longer accepts \`?raw\`. **Migration:** drop the parameter; the response is unchanged.` |

Three tests an entry should pass:

1. **Would a stranger know whether this affects them?** If it names an internal
   class, no.
2. **Is it the symptom or the patch?** Readers experienced the symptom.
3. **If it breaks something, does it say what to do?** A break without a migration
   line is a support ticket you have scheduled for later.

## Not notable

Skip entries entirely for: internal refactors with no surface change, test-only
changes, formatting, CI tweaks, dependency bumps that change no behaviour, and
docs. These still need conventional commits — they just do not need a line in a
file operators read. `chore`, `ci`, `test`, `style` and `refactor` commits are
normally invisible here; `docs` appears only when it documents a shipped feature.
