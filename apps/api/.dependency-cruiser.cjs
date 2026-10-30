// @ts-check
/**
 * Architecture rules for @knowledge/api.
 *
 * The rules that matter most here are the *process boundaries*. This workspace
 * has several entrypoints sharing one `src` tree (CLAUDE.md: "The worker is a
 * second entrypoint of apps/api, not a separate app"):
 *
 *   main.ts         → AppModule     (HTTP: controllers, WS gateway, sweepers)
 *   worker.main.ts  → WorkerModule  (BullMQ processors, no HTTP)
 *   mcp.main.ts     → McpModule     (stdio JSON-RPC)
 *   learner.main.ts → LearnerModule (#305: a timer that proposes learnings)
 *   git.main.ts     → GitModule     (#636: smart-HTTP git remote, its own controller only)
 *
 * Nothing in the type system stops AppModule from importing a module that
 * transitively pulls in a BullMQ processor — and the failure is silent and
 * expensive: the API process quietly starts consuming jobs alongside the
 * worker. Equally, a controller reaching the worker fails the other way, at
 * boot, because its guards need AccessService. `reachable: true` is the only
 * thing that can express "not even indirectly", which is what these invariants
 * actually are.
 *
 * Paths are relative to this directory — run via `pnpm --filter @knowledge/api
 * run depcruise`, which sets the cwd.
 */

/** Feature directories: everything that is not the base/leaf layer. */
const FEATURES =
  '^src/(activity|agents|ai|assistant|attachments|auth|avatars|collab|connectors|documents|embedding|entities|events|extraction|fulltext|glossary|graph|import|ingestion|learner|mcp|notifications|profiles|projects|search|users|workflows|workspaces)/';

/** The base layer: infrastructure every feature may use, which may use none of them. */
const LEAF = '^src/(common|config|prisma|storage|i18n|observability)/';

module.exports = {
  forbidden: [
    // ---------------------------------------------------------------- process boundaries
    {
      name: 'api-loads-no-processor',
      comment:
        'The HTTP process must not reach a BullMQ processor, even transitively — importing ' +
        'IngestionWorkerModule (or anything that does) into AppModule makes the API silently ' +
        'start consuming jobs alongside the worker.',
      severity: 'error',
      from: { path: '^src/app\\.module\\.ts$' },
      to: { path: '\\.processor\\.ts$', reachable: true },
    },
    {
      name: 'api-loads-no-worker-module',
      comment:
        'Worker-only modules (*-worker.module.ts) belong to WorkerModule alone. Reaching one ' +
        'from AppModule is the same defect as above, one level up.',
      severity: 'error',
      from: { path: '^src/app\\.module\\.ts$' },
      to: { path: '-worker\\.module\\.ts$', reachable: true },
    },
    {
      name: 'worker-loads-no-controller',
      comment:
        'The worker has no HTTP layer. A controller reaching it drags in guards that need ' +
        'AccessService and fails at boot. This is why the *-core.module.ts splits exist ' +
        '(AiCoreModule, DocumentsCoreModule, ...): controller-free halves the worker can import.',
      severity: 'error',
      from: { path: '^src/worker\\.module\\.ts$' },
      to: { path: '\\.controller\\.ts$', reachable: true },
    },
    {
      name: 'worker-loads-no-gateway',
      comment:
        'EventsModule is publisher-only and worker-safe; EventsApiModule holds the subscriber, ' +
        'the SSE controller and the WS gateway and is API-only. Keep that split intact.',
      severity: 'error',
      from: { path: '^src/worker\\.module\\.ts$' },
      to: { path: '\\.gateway\\.ts$', reachable: true },
    },
    {
      name: 'worker-loads-no-documents-module',
      comment:
        'DocumentsModule will not load in the worker (MergeRequestsService needs AccessService). ' +
        'This is what forces "the worker generates, the API publishes" — the processor leaves ' +
        'work in `materializing` and an API-side sweeper finishes it. Use DocumentsCoreModule.',
      severity: 'error',
      from: { path: '^src/worker\\.module\\.ts$' },
      to: { path: '^src/documents/documents\\.module\\.ts$', reachable: true },
    },
    {
      name: 'worker-loads-no-captures',
      comment:
        'Captures (issue #73) open merge requests as the person who captured, so they run API-side ' +
        'only. CapturesCoreModule is controller-free for the MCP tool set, not for the worker.',
      severity: 'error',
      from: { path: '^src/worker\\.module\\.ts$' },
      to: { path: '^src/captures/', reachable: true },
    },
    {
      name: 'documents-imports-no-captures',
      comment:
        'Captures build on documents (merge requests, relation proposals), never the reverse: ' +
        'MergeRequestsService knows a capture only as a plain `captureId` argument. A reach back ' +
        'closes a module cycle through DocumentsModule.',
      severity: 'error',
      from: { path: '^src/documents/' },
      to: { path: '^src/captures/' },
    },
    {
      name: 'collab-stays-api-only',
      comment:
        'CollabModule holds the /v1/collab gateway and its Hocuspocus instance (#80). In the ' +
        'worker it would open Redis connections nobody uses; in the MCP server, started once per ' +
        'agent client, every process would store drafts racing the API. A worker or MCP path that ' +
        'needs drafts gets a controller- and gateway-free core module instead. The HTTP MCP ' +
        '(mcp-http.module.ts) runs in the API process and does import it, for the draft tools (#316); ' +
        'McpService knows them only as an argument, so McpCoreModule stays collab-free.',
      severity: 'error',
      from: { path: '^src/(worker|mcp/mcp)\\.module\\.ts$' },
      to: { path: '^src/collab/collab\\.module\\.ts$', reachable: true },
    },
    {
      name: 'mcp-loads-no-processor',
      comment:
        'The MCP server is a read/act surface over stdio, not a job runner. It legitimately ' +
        'imports controller-bearing modules (ProjectsModule, SearchModule, ...), so controllers ' +
        'are NOT forbidden here — but a processor would make every agent client a competing ' +
        'queue consumer.',
      severity: 'error',
      from: { path: '^src/mcp/mcp\\.module\\.ts$' },
      to: { path: '\\.processor\\.ts$', reachable: true },
    },
    {
      name: 'mcp-loads-no-sweeper',
      comment:
        'Same argument as processors, one step weaker: a sweeper is a timer that writes. The ' +
        'MCP process is started once per agent client, so a sweeper reachable from McpModule ' +
        'runs in N processes at once, all racing the API for the same rows.\n' +
        'This currently has one known violation, recorded in the baseline: McpModule imports ' +
        'DocumentsModule, which provides MentionReplySweeper. That sweeper is meant to be ' +
        'API-side ("the worker generates, the API publishes"), and it settles pending @agent ' +
        'mention comments — work that is claimed by a guarded INSERT, so the race is survivable ' +
        'but real. Fixing it means a controller-free split (the DocumentsCoreModule pattern) ' +
        'that keeps the sweeper out of whatever MCP imports.',
      severity: 'error',
      from: { path: '^src/mcp/mcp\\.module\\.ts$' },
      to: { path: '\\.sweeper\\.ts$', reachable: true },
    },
    {
      name: 'learner-loads-no-controller',
      comment:
        'The learner (#305) is an application context like the worker: no HTTP layer, so a ' +
        'controller reaching it drags in guards that need AccessService. Same rule, same reason.',
      severity: 'error',
      from: { path: '^src/learner/learner\\.module\\.ts$' },
      to: { path: '\\.controller\\.ts$', reachable: true },
    },
    {
      name: 'learner-loads-no-gateway',
      comment: 'No WebSocket or collab gateway either: the learner serves nobody.',
      severity: 'error',
      from: { path: '^src/learner/learner\\.module\\.ts$' },
      to: { path: '\\.gateway\\.ts$', reachable: true },
    },
    {
      name: 'learner-loads-no-processor',
      comment:
        'A processor reachable from the learner would make it a second consumer of BullMQ jobs ' +
        'alongside the worker. The learner reads Postgres and calls one model; it consumes no queue.',
      severity: 'error',
      from: { path: '^src/learner/learner\\.module\\.ts$' },
      to: { path: '\\.processor\\.ts$', reachable: true },
    },
    {
      name: 'learner-loads-no-sweeper',
      comment:
        'Sweepers belong to the API (or the worker). One reachable from the learner would run in a ' +
        'third process, racing the others for the same rows. Its own clock is learner.ticker.ts, ' +
        'which writes only proposals ("the worker generates, the API publishes").',
      severity: 'error',
      from: { path: '^src/learner/learner\\.module\\.ts$' },
      to: { path: '\\.sweeper\\.ts$', reachable: true },
    },
    {
      name: 'learner-loads-no-worker-module',
      comment: 'Worker-only modules (*-worker.module.ts) belong to WorkerModule alone, as for AppModule.',
      severity: 'error',
      from: { path: '^src/learner/learner\\.module\\.ts$' },
      to: { path: '-worker\\.module\\.ts$', reachable: true },
    },
    {
      name: 'learner-stays-out-of-the-other-processes',
      comment:
        'Nothing but learner.main.ts may load the learner module or its ticker: in AppModule or ' +
        'WorkerModule the ticker would start a second learner inside that process. The pure halves ' +
        '(learner-derive.ts, learner-calibration.ts) are free to import — the backtest does.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/(learner/|learner\\.main\\.ts$)' },
      to: { path: '^src/learner/learner\\.(module|ticker|service)\\.ts$' },
    },
    {
      name: 'git-loads-no-other-controller',
      comment:
        'The git process (#636) authenticates in GitAccessService, not through AuthModule\'s global ' +
        'guards, so any controller but its own would boot without the guard it relies on. It loads ' +
        'controller-free core modules (AuthCoreModule, PermissionsCoreModule, ...) only.',
      severity: 'error',
      from: { path: '^src/git/git\\.module\\.ts$' },
      to: { path: '\\.controller\\.ts$', pathNot: '^src/git/git\\.controller\\.ts$', reachable: true },
    },
    {
      name: 'git-loads-no-gateway',
      comment: 'No WebSocket or collab gateway: the git process serves smart HTTP and nothing else.',
      severity: 'error',
      from: { path: '^src/git/git\\.module\\.ts$' },
      to: { path: '\\.gateway\\.ts$', reachable: true },
    },
    {
      name: 'git-loads-no-processor',
      comment: 'A processor here would make the git process a second consumer of BullMQ jobs beside the worker.',
      severity: 'error',
      from: { path: '^src/git/git\\.module\\.ts$' },
      to: { path: '\\.processor\\.ts$', reachable: true },
    },
    {
      name: 'git-loads-no-sweeper',
      comment: 'Sweepers belong to the API or the worker; one here would race them for the same rows.',
      severity: 'error',
      from: { path: '^src/git/git\\.module\\.ts$' },
      to: { path: '\\.sweeper\\.ts$', reachable: true },
    },
    {
      name: 'git-loads-no-worker-module',
      comment: 'Worker-only modules (*-worker.module.ts) belong to WorkerModule alone.',
      severity: 'error',
      from: { path: '^src/git/git\\.module\\.ts$' },
      to: { path: '-worker\\.module\\.ts$', reachable: true },
    },
    {
      name: 'git-stays-out-of-the-other-processes',
      comment:
        'Nothing but git.main.ts may load GitModule or its controller: in AppModule the API would ' +
        'serve packs, which the house rule "the API never streams file bodies" forbids. ' +
        'GitCoreModule (stored commits) is the half every process imports.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/(git/|git\\.main\\.ts$)' },
      to: { path: '^src/git/(git\\.module|git\\.controller|git-access\\.service|git-repo\\.service)\\.ts$' },
    },
    {
      name: 'entrypoints-stay-separate',
      comment:
        'worker.main.ts, mcp.main.ts, learner.main.ts and git.main.ts must never reach AppModule — ' +
        'that would boot the whole HTTP application inside another process.',
      severity: 'error',
      from: { path: '^src/(worker|mcp|learner|git)\\.main\\.ts$' },
      to: { path: '^src/app\\.module\\.ts$', reachable: true },
    },

    // ---------------------------------------------------------------- layering
    {
      name: 'leaf-layer-imports-no-feature',
      comment:
        'common/, config/, prisma/, storage/ and i18n/ are the base layer: every feature may ' +
        'use them, they may use no feature. A back-edge here is what turns a boot order into a ' +
        'puzzle.',
      severity: 'error',
      from: { path: LEAF },
      to: { path: FEATURES },
    },
    {
      name: 'controller-imported-only-by-its-module',
      comment:
        'Controllers are edges of the graph: Nest instantiates them from a module and nothing ' +
        'else should import one. A service reaching for a controller means logic is in the ' +
        'wrong place — move it into a service both can use.',
      severity: 'error',
      from: { pathNot: '\\.module\\.ts$|\\.controller\\.ts$|\\.spec\\.ts$' },
      to: { path: '\\.controller\\.ts$' },
    },

    // ---------------------------------------------------------------- dependency inversion
    //
    // These are the SOLID rules that are actually dependency-shaped. A module
    // graph can see which file imports which file and nothing else, so the D
    // in SOLID is the only letter it can check directly: depend on the
    // abstraction (the DI token, the registry, the types file), never on the
    // concrete class behind it. The rest of SOLID — SRP, LSP, OCP, ISP — and
    // ACID transaction boundaries live *inside* files, where this tool cannot
    // look. See the note at the bottom of this file.
    {
      name: 'dip-provider-impl-stays-behind-its-token',
      comment:
        'The pluggable providers (EMBEDDING_PROVIDER, RELATION_EXTRACTOR, FULLTEXT_PROVIDER) are ' +
        'this codebase\'s Dependency Inversion seam: callers inject the token declared in ' +
        '`<seam>.provider.ts` and the module decides which implementation fills it from env. ' +
        'Importing `openai-compatible.provider.ts` (or the stub/noop/opensearch one) from outside ' +
        'its own seam hard-wires a consumer to one implementation and defeats the swap.\n' +
        'Caveat: written as one rule over the three seams, so one seam importing another seam\'s ' +
        'implementation would slip through. Nothing does that today.',
      severity: 'error',
      from: { pathNot: '^src/(embedding|extraction|fulltext)/' },
      to: {
        path: '^src/(embedding|extraction|fulltext)/(openai-compatible|stub|noop|opensearch)\\.provider\\.ts$',
      },
    },
    {
      name: 'dip-connector-adapter-stays-behind-the-registry',
      comment:
        'Connector adapters are resolved by kind through ConnectorRegistry. Reaching a specific ' +
        'adapter directly is the same defect as `new ConfluenceAdapter()` in a service: the ' +
        'closed catalogue in CONNECTOR_KIND_INFO stops being the single source of truth.',
      severity: 'error',
      from: { pathNot: '^src/connectors/adapters/' },
      to: { path: '^src/connectors/adapters/.+\\.adapter\\.ts$' },
    },
    {
      name: 'dip-document-parser-stays-behind-the-registry',
      comment:
        'Parsers are routed by `importFormatFor` through ParserRegistry. One known violation is ' +
        'baselined: import.processor.ts imports `extensionFor` from docx.parser.ts directly — a ' +
        'helper reached past the registry. Moving it to parser.types.ts (or the registry) clears it.',
      severity: 'error',
      from: { pathNot: '^src/import/parsers/' },
      to: { path: '^src/import/parsers/.+\\.parser\\.ts$' },
    },
    {
      name: 'graph-access-only-through-graph-service',
      comment:
        'plan.md §6 security note: GraphService is the single injection point for the mandatory ' +
        'workspace predicate on every ArcadeDB query. A caller holding ArcadeClient directly can ' +
        'issue a query with no tenant filter, which is a cross-workspace data leak — the one rule ' +
        'here that is a security boundary rather than a style preference.',
      severity: 'error',
      from: { pathNot: '^src/graph/' },
      to: { path: '^src/graph/arcade\\.client\\.ts$' },
    },

    // ---------------------------------------------------------------- write boundaries (ACID-adjacent)
    {
      name: 'transaction-boundary-lives-in-a-service',
      comment:
        'A controller holding PrismaService writes with no service owning the operation, so there ' +
        'is no single place to wrap it in `prisma.$transaction` when it grows a second statement. ' +
        'Atomicity itself is invisible to a dependency graph — this rule only keeps writes in a ' +
        'layer where a transaction *can* be introduced. One violation is baselined: me.controller.ts ' +
        'calls `prisma.user.update()` twice (profile patch and API-key rotation).',
      severity: 'error',
      from: { path: '\\.controller\\.ts$' },
      to: { path: '^src/prisma/prisma\\.service\\.ts$' },
    },
    {
      name: 'dto-stays-a-dto',
      comment:
        'A DTO is a shape at the edge: validation decorators and fields. Importing a service or a ' +
        'controller into one turns request parsing into a place that can execute behaviour, and ' +
        'drags the whole service graph into the OpenAPI generator.',
      severity: 'error',
      from: { path: '\\.dto\\.ts$' },
      to: { path: '\\.service\\.ts$|\\.controller\\.ts$' },
    },

    // ---------------------------------------------------------------- cycles & hygiene
    {
      name: 'no-circular',
      comment:
        'Runtime cycles only — `dependencyTypesNot: type-only` ignores cycles made purely of ' +
        '`import type`, which erase at compile time and cannot cause a TDZ/undefined-export ' +
        'fault. That matters here because @knowledge/contracts domain barrels legitimately ' +
        'cross-reference each other via package self-reference.\n' +
        'The `via.pathNot` exempts the one sanctioned cycle: AiModule <-> AssistantModule, ' +
        'which is a deliberate two-way forwardRef (a turn needs config/usage/skills/plugins; ' +
        '"Test connection" needs AssistantClient). Note this exemption is keyed on those two ' +
        'files, so a NEW cycle routed through either module would also be excused — if you add ' +
        'one, prefer fixing it to widening this.',
      severity: 'error',
      from: {},
      to: {
        circular: true,
        via: {
          dependencyTypesNot: ['type-only'],
          pathNot: '^src/(ai/ai|assistant/assistant)\\.module\\.ts$',
        },
      },
    },
    {
      name: 'no-orphans',
      comment:
        'A module nothing imports is either dead or a forgotten wiring step. Entrypoints, ' +
        'declaration files and standalone scripts are legitimately unreferenced.',
      severity: 'error',
      from: {
        orphan: true,
        pathNot: '\\.d\\.ts$|^src/(main|worker\\.main|mcp\\.main|learner\\.main)\\.ts$|^src/scripts/',
      },
      to: {},
    },
    {
      name: 'not-to-unresolvable',
      comment:
        'Catches the ESM trap this workspace is prone to: NodeNext requires the `.js` suffix on ' +
        'relative imports, including from .ts sources. A missing suffix resolves here and ' +
        'explodes at runtime.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'not-to-dev-dep',
      comment:
        'Runtime code may not import a devDependency — it is absent in a production install. ' +
        'Type-only imports are fine (they erase).',
      severity: 'error',
      from: { path: '^src', pathNot: '\\.spec\\.ts$' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-deprecated-core',
      comment: 'Deprecated Node core modules are removed without much ceremony.',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: '^(punycode|domain|sys|_linklist|constants)$' },
    },
    {
      name: 'no-duplicate-dep-types',
      comment: 'A package listed in both dependencies and devDependencies is an install-order coin flip.',
      severity: 'error',
      from: {},
      to: { moreThanOneDependencyType: true, dependencyTypesNot: ['type-only'] },
    },

    // ---------------------------------------------------------------- workspace isolation
    {
      name: 'api-imports-no-web',
      comment:
        'The two apps share types through @knowledge/contracts and nothing else. Reaching into ' +
        "the other app's source couples a Nest build to a Vite one.",
      severity: 'error',
      from: { path: '^src' },
      to: { path: '^\\.\\./web/' },
    },
  ],

  /**
   * Positive contracts: "every X must depend on Y". This is the closest a
   * dependency graph gets to Liskov/Interface Segregation — it cannot check
   * that an implementation *honours* a contract, only that every implementation
   * is written against the same one, so a new adapter cannot quietly invent its
   * own shape and diverge from the catalogue.
   */
  required: [
    {
      name: 'adapter-implements-the-connector-contract',
      comment:
        'Every connector adapter must reference connector.types.ts — the DocumentParser-shaped ' +
        'interface all of them satisfy (and where `push` being optional is how Jira declares ' +
        'itself pull-only). An adapter that imports none of it is not implementing the contract.',
      severity: 'error',
      module: { path: '^src/connectors/adapters/.+\\.adapter\\.ts$' },
      to: { path: '^src/connectors/adapters/connector\\.types\\.ts$' },
    },
    {
      name: 'parser-implements-the-parser-contract',
      comment:
        'Every document parser must reference parser.types.ts, the one DocumentParser interface ' +
        'the registry routes against — including the `warnings[]` each parser returns to say what ' +
        'it could not carry, which is the whole point of the import review step.',
      severity: 'error',
      module: { path: '^src/import/parsers/.+\\.parser\\.ts$' },
      to: { path: '^src/import/parsers/parser\\.types\\.ts$' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    // tsconfig.build.json (not tsconfig.json) — it carries an explicit
    // `include: ["src"]` and excludes dist/spec, so resolution matches what
    // `nest build` actually compiles.
    tsConfig: { fileName: 'tsconfig.build.json' },
    // Follow `import type` too: without this the contracts barrels look like
    // orphans and the buildless packages go uncruised.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      // The workspace packages are consumed from source through their own
      // `exports` maps (package self-reference), so the resolver has to honour
      // exports/conditions the way Node does.
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      archi: {
        collapsePattern: '^(src/[^/]+|\\.\\./\\.\\./packages/[^/]+)',
      },
    },
  },
};

/**
 * ---------------------------------------------------------------------------
 * What this file deliberately does NOT check
 * ---------------------------------------------------------------------------
 *
 * dependency-cruiser sees one thing: which module imports which module. It
 * never opens a class, a method or a statement. So most of ACID/OOP/SOLID is
 * not expressible here, and a rule claiming otherwise would pass while
 * enforcing nothing:
 *
 *   ACID          Atomicity is `prisma.$transaction` wrapping the right set of
 *                 statements — a fact about statements, invisible to an import
 *                 graph. `transaction-boundary-lives-in-a-service` above only
 *                 keeps writes in a layer where a transaction *can* be added.
 *                 The real check is a lint rule (an un-awaited write escapes
 *                 its transaction: oxlint's no-floating-promises) plus review.
 *   SRP           "One reason to change" is a claim about a class's behaviour.
 *                 Fan-in is the tempting proxy and it is a bad one here: the
 *                 most-imported modules are i18n/t.ts (76), prisma.service.ts
 *                 (67) and common/validation.ts (42) — shared leaves, where
 *                 high fan-in means stability, not a god object.
 *   OCP / LSP     Both are about substitutability of implementations. The
 *                 `required` rules above check only that every adapter/parser
 *                 is written against the same interface, never that it honours
 *                 it. A test suite is what checks that.
 *   ISP           Interface width is invisible; only "does it import the
 *                 contract at all" is.
 *   Encapsulation Private/protected, getters, inheritance depth — all AST.
 *
 * Two measured candidates were evaluated and rejected rather than shipped:
 *
 *   Stable Dependency Principle (`to.moreUnstable`) — 97 violations, almost
 *   all of the form `x.module.ts -> x.controller.ts`. A Nest module MUST
 *   import the controllers and providers it declares; with high fan-out and
 *   near-zero fan-in it is maximally "unstable" by the metric, so the
 *   framework's own wiring trips the rule. SDP was written for packages, not
 *   DI manifests.
 *
 *   Folder-level cycles (`scope: 'folder'`) — 52 violations across the feature
 *   directories (agents <-> ai <-> assistant <-> documents <-> events). That
 *   is a true description of a richly cross-referential domain, not a defect,
 *   and baselining 52 entries would only add noise.
 *
 * Both are still worth *looking* at occasionally, as a report rather than a
 * gate: `depcruise src --metrics` prints instability per module.
 */
