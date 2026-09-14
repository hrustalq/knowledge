// @ts-check
/**
 * Architecture rules for the buildless workspace packages (packages/*).
 *
 * `@knowledge/contracts`, `@knowledge/workflow` and `@knowledge/observability`
 * are consumed **from source** — their `exports` maps point at `.ts` files and
 * nothing ever builds them.
 * That buys both apps a zero-step shared vocabulary, and it costs a constraint
 * that no typechecker will enforce for you (CLAUDE.md, "buildless package
 * constraints"):
 *
 *   - Node will not resolve a relative `./x.js` specifier into a sibling `.ts`.
 *   - An explicit `./x.ts` resolves at runtime but is rejected by any consumer
 *     that emits (TS5097), so `apps/api` can never accept it.
 *   - The escape is package **self-reference**: `@knowledge/contracts/core`,
 *     which is neither relative nor `.ts`, so Node resolves it through the
 *     package's own exports map and an emitting `tsc` accepts it.
 *
 * The trap is that this fails *only at runtime*: `make check` passes clean
 * either way. These rules are the check that `tsc` cannot be.
 *
 * Run from the repo root via `pnpm depcruise:packages`.
 */

module.exports = {
  forbidden: [
    {
      name: 'buildless-no-relative-imports',
      comment:
        'A relative import between two files inside a buildless package resolves at typecheck ' +
        'and throws ERR_MODULE_NOT_FOUND at runtime. Import through the package\'s own name ' +
        "instead — `@knowledge/contracts/core`, not `../core/index.js`. Adding a domain means " +
        'adding an `exports` entry for it in package.json.',
      severity: 'error',
      // Matched structurally (every package's src), not by name. An earlier
      // draft enumerated `(contracts|workflow)` and `@knowledge/observability`
      // was added the same week — a new buildless package would have silently
      // escaped the one rule that catches a fault nothing else can. `tsconfig`
      // has no src/ and drops out on its own.
      from: { path: '^packages/[^/]+/src' },
      to: { dependencyTypes: ['local'] },
    },
    {
      name: 'contracts-has-no-runtime-deps',
      comment:
        'Zero runtime dependencies is what lets an emitting Nest build and a Vite bundle both ' +
        'consume @knowledge/contracts from source. A single npm import here breaks one of them, ' +
        'and the package is meant to be plain types plus a few const tables anyway.',
      severity: 'error',
      from: { path: '^packages/contracts/src' },
      to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'packages-import-no-app',
      comment:
        'Packages are consumed by the apps, never the reverse. A package reaching into apps/ ' +
        'makes the dependency graph a cycle at the workspace level.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      comment:
        'Runtime cycles only. The contracts domain barrels cross-reference each other through ' +
        'self-reference, but those edges are all `import type` and erase at compile time — a ' +
        'cycle that survives to runtime here would break both consumers.',
      severity: 'error',
      from: {},
      to: { circular: true, via: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'A specifier that does not resolve — most likely a missing `exports` entry.',
      from: {},
      to: { couldNotResolve: true },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
