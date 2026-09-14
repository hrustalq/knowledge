// Node-side logging and correlation, shared by apps/api (all four entrypoints)
// and apps/web's SSR server.
//
// Why a package rather than a directory in apps/api: apps/web/server.js is a
// real Node process, and without sharing this, an SSR render calls the API with
// no correlation at all — browser, SSR and API each get their own unrelated id,
// or none. Sharing puts them on one trace.
//
// What is NOT here, deliberately:
//   - the record *types* — those are @knowledge/contracts/observability, so the
//     browser half can speak the same shape without reaching a Node package;
//   - the Nest LoggerService adapter — it imports @nestjs/common, which the web
//     must never pull, and it uses a TS parameter property, which strip-only
//     mode rejects. It stays in apps/api.
//
// Cross-file imports below go through the package's own name, never a relative
// path: Node will not resolve './x.js' into a sibling './x.ts', and an explicit
// './x.ts' is rejected by any consumer that emits. Same rule as contracts.
//
// `./express` is deliberately not re-exported here: importing this barrel should
// never drag in HTTP plumbing.
export * from '@knowledge/observability/trace';
export * from '@knowledge/observability/logger';
export * from '@knowledge/observability/backtest';
