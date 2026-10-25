import { ApiExtension } from '@nestjs/swagger';
import type { ContractResponses } from './contract-responses.generated.js';

/**
 * The `@knowledge/contracts` type a route answers with (#472).
 *
 * Two jobs from one name. At compile time the handler must return that type —
 * the descriptor's constraint fails the build otherwise — so the schema and the
 * code cannot disagree. In the OpenAPI document `config/swagger.ts` turns the
 * name into the 2xx response schema, generated from the contracts type itself
 * (`scripts/generate-contract-schemas.mjs`), which is what lets the web client
 * read typed data with no cast at the call site.
 *
 * A new name is picked up by `make api-schema`; until then it fails here as an
 * unknown key.
 */
export function Returns<N extends keyof ContractResponses>(
  name: N,
): <M extends (...args: never[]) => ContractResponses[N] | Promise<ContractResponses[N]>>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<M>,
) => void;
/**
 * A route that negotiates (`Accept: text/markdown` answers text through
 * `@Res({ passthrough: true })`): the JSON representation is still checked,
 * and the text answer is allowed rather than hidden behind a cast.
 */
export function Returns<N extends keyof ContractResponses>(
  name: N,
  opts: { orText: true },
): <M extends (...args: never[]) => Promise<ContractResponses[N] | string | undefined>>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<M>,
) => void;
export function Returns(name: string, _opts?: { orText: true }) {
  return (target: object, key: string | symbol, descriptor: PropertyDescriptor): void => {
    ApiExtension('x-returns', name)(target, key, descriptor);
  };
}
