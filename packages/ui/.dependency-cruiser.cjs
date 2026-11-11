// @ts-check
/**
 * Rules for @knowledge/ui (#941): the UI kit and the page chrome.
 *
 * Checked here rather than by the root config because these are Vue files and
 * only a workspace that installs `vue` can parse them. Run via
 * `pnpm --filter @knowledge/ui run depcruise` (part of `make deps`).
 */
module.exports = {
  forbidden: [
    {
      name: 'ui-imports-no-app',
      comment:
        'A component lives here because it has no domain. It imports nothing from an app; what ' +
        'an app must supply (an error formatter, remembered state) reaches it by prop, slot or inject.',
      severity: 'error',
      from: {},
      to: { path: '(^|/)apps/' },
    },
    {
      name: 'ui-imports-no-workspace-package',
      comment:
        '@knowledge/ui imports no other @knowledge/* package: a kit that knows the contracts ' +
        'knows the domain, and every other package is consumed by Node, which this one is not.',
      severity: 'error',
      from: {},
      to: { path: '(^|/)packages/(?!ui/)' },
    },
    {
      name: 'no-circular',
      comment: 'Runtime cycles only: a cycle between SFCs is an undefined component at render time.',
      severity: 'error',
      from: {},
      to: { circular: true, via: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'A broken import specifier.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.d.ts', '.js', '.vue', '.json'],
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
}
