// @ts-check
/**
 * Rules for the admin console (#1236). Run via `pnpm --filter @knowledge/admin
 * run depcruise` (part of `make deps`).
 *
 * The layers are apps/web's (docs/architecture/11), so a file goes where it
 * would go there:
 *
 *   app → modules → entities → stores → shared     (assets/ from anywhere)
 *
 * The rules below are copied from apps/web/.dependency-cruiser.cjs; the console
 * has no widgets/ or core/ yet, and adds them with their rules when it does.
 * The other half of the app boundary, `web-imports-no-admin`, is in apps/web.
 */
module.exports = {
  forbidden: [
    // ---------------------------------------------------------------- layers
    {
      name: 'modules-import-no-app',
      comment: 'app/ composes the modules (the shell, the router); a module reaching back into it makes the shell a dependency of every section.',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'no-module-to-module',
      comment: 'A module is a section with routes, and only app/ composes them. What two share is an entity or shared/.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/', pathNot: '^src/modules/$1/' },
    },
    {
      name: 'entities-import-no-module',
      comment: "An entity is a domain's building blocks for the modules above it; one that imports a module is that module's internals, misfiled.",
      severity: 'error',
      from: { path: '^src/entities/' },
      to: { path: '^src/(app|modules)/' },
    },
    {
      name: 'stores-import-only-shared',
      comment: 'stores/ holds only cross-cutting state (who is signed in); a feature registers with it, never the reverse.',
      severity: 'error',
      from: { path: '^src/stores/' },
      to: { path: '^src/(app|modules|entities)/' },
    },
    {
      name: 'shared-is-business-agnostic',
      comment: 'shared/ (the client, i18n) knows no feature. The kit and the page chrome are @knowledge/ui.',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(app|modules|entities|stores)/' },
    },
    {
      name: 'entity-via-index-only',
      comment: "An entity's index.ts is its only public surface.",
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/entities/' },
      to: { path: '^src/entities/', pathNot: '^src/entities/[^/]+/index\\.ts$' },
    },
    {
      name: 'app-via-module-index',
      comment:
        "app/ and main.ts reach a module through its index.ts (what the shell mounts) or its routes.ts (what the router mounts).",
      severity: 'error',
      from: { path: '^src/(app/|[^/]+$)' },
      to: { path: '^src/modules/', pathNot: '^src/modules/[^/]+/(index|routes)\\.ts$' },
    },

    // ---------------------------------------------------------------- app boundary
    {
      name: 'admin-imports-no-other-app',
      comment:
        'The console is its own bundle and its own image. It reaches the API over HTTP only, and ' +
        'shares code with apps/web through packages — never by importing the member app.',
      severity: 'error',
      from: { path: '^src' },
      to: { path: '(^|/)apps/(?!admin/)|^\\.\\./(web|api)/' },
    },
    {
      name: 'admin-imports-only-browser-packages',
      comment:
        'A browser bundle may use the kit, the client and the contracts. The editor schema, the ' +
        'workflow engine and the observability package belong to the member app and the server.',
      severity: 'error',
      from: { path: '^src' },
      to: { path: '(^|/)packages/(editor-schema|workflow|observability)/|@knowledge/(editor-schema|workflow|observability)' },
    },
    {
      name: 'admin-imports-no-server-only',
      comment: 'Prisma and the S3 client are server-side dependencies; importing one means bundling it for the browser.',
      severity: 'error',
      from: { path: '^src' },
      to: { path: '^(@prisma/client|prisma|@aws-sdk/)' },
    },

    // ---------------------------------------------------------------- cycles & hygiene
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true, via: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'no-orphans',
      comment: 'A file nothing imports is dead or a forgotten wiring step.',
      severity: 'error',
      from: { orphan: true, pathNot: '\\.d\\.ts$|\\.spec\\.ts$|^src/main\\.ts$|\\.css$|^src/assets/' },
      to: {},
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
    // The packages are checked by their own rules (root and packages/ui configs).
    doNotFollow: { path: ['node_modules', '^\\.\\./\\.\\./packages/'] },
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
