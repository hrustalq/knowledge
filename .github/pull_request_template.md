<!--
The PR title IS the commit message — merges are squash-only. It must be a valid
conventional commit header: `feat(web): add saved filter rail`
See CONTRIBUTING.md#pull-requests.
-->

## What and why

<!-- The diff says what changed. Say why it changed, and what you decided against. -->

## Changelog

<!--
Paste the entry you added to CHANGELOG.md under ## [Unreleased].
Delete this section only if the change is genuinely not notable — a refactor,
tests, CI, or a dependency bump with no behaviour change.
Template: docs/templates/changelog-entry.md
-->

## Checklist

- [ ] `make verify` passes (the pre-push hook runs it)
- [ ] Changelog entry added under `## [Unreleased]`, or the change is not notable
- [ ] New or changed routes carry `@Access(role, source)`
- [ ] Breaking changes use `!` + a `BREAKING CHANGE:` footer and a **Breaking**
      changelog entry with a **Migration:** line

### If this PR touches the database

- [ ] The migration is **expand/contract** — the previous release's image can run
      against this schema ([why](../docs/versioning.md#rollback-and-the-expandcontract-rule))
- [ ] A NOT NULL column on a populated table was created with
      `prisma migrate dev --create-only` and hand-edited to nullable → `UPDATE` →
      `SET NOT NULL`
- [ ] An **Operations** changelog entry describes anything the deployer must do

### If this PR touches configuration

- [ ] New env vars have a working default, or are documented as breaking
- [ ] `.env.example` updated (`make env-check`)
