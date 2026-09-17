/**
 * Conventional Commits, enforced on every commit by .husky/commit-msg.
 *
 * The version bump and the changelog are both chosen from `git log <lastTag>..dev`
 * (see CONTRIBUTING.md#release), so a commit that does not parse is a release note
 * that has to be reconstructed by hand later.
 *
 * CommonJS on purpose: the root package.json has no `"type": "module"`.
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // The types that may appear. `feat` and `fix` drive the bump; the rest are
    // invisible to the changelog but still describe the change honestly.
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style', 'revert'],
    ],

    // Scope stays free-form. An enum here would have to list every app, package
    // and feature slug, and would reject a correct commit for a new area before
    // anyone remembered to add it — a lint rule that fails on new work gets
    // disabled rather than obeyed. CONTRIBUTING.md recommends the usual values.
    'scope-enum': [0],

    // Subject is imperative and lowercase: "add saved filter rail", never
    // "Added SavedFilterRail." (inherited from config-conventional, restated
    // because it is the rule this repo's existing sentence-case history breaks).
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],

    // Off. This codebase's convention is a body that explains *why*, and that
    // means prose paragraphs and the occasional long URL or error string. A hard
    // wrap at 100 would reject correct commits for cosmetics.
    'body-max-line-length': [0],
  },
};
