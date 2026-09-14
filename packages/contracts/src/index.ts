// Public surface of @knowledge/contracts.
//
// Split by domain under src/<domain>/. Cross-domain references import through
// the package's own name (`@knowledge/contracts/core`), never a relative path: Node strips
// types per file but will not resolve a relative './x.js' into a sibling
// './x.ts', and an explicit './x.ts' is rejected by any consumer that emits
// (TS5097, and allowImportingTsExtensions is illegal alongside emit). Package
// self-reference resolves in both, which is what keeps this package buildless.
export * from '@knowledge/contracts/core';
export * from '@knowledge/contracts/documents';
export * from '@knowledge/contracts/graph';
export * from '@knowledge/contracts/reviews';
export * from '@knowledge/contracts/identity';
export * from '@knowledge/contracts/notifications';
export * from '@knowledge/contracts/ai';
export * from '@knowledge/contracts/content';
export * from '@knowledge/contracts/workflows';
export * from '@knowledge/contracts/connectors';
export * from '@knowledge/contracts/observability';
