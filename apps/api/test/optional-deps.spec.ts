import { NestFactory } from '@nestjs/core';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * An `@Optional()` constructor dependency Nest cannot resolve is injected as
 * `undefined`, silently (#1171). #1164 shipped background runs with no memory
 * that way: a type-only import emitted `Object` as the parameter type. Specs
 * that construct a service positionally never see it, so this resolves every
 * entrypoint's real module graph — `preview` builds the graph without
 * instantiating a provider, so no infra is touched — and requires every
 * class-typed optional dependency to have resolved.
 *
 * A symbol/string token is a test seam with a production fallback
 * (`API_TRY_FETCH`, `CHAT_SOCKET_FACTORY`, `CHAT_INBOX_CLAIMS`): allowed.
 */

type Wrapper = { metatype: unknown; getCtorMetadata?: () => unknown[] | undefined };
type Container = { getModules(): Map<string, { providers: Map<unknown, Wrapper> }> };

async function unresolved(root: unknown, name: string): Promise<string[]> {
  const app = await NestFactory.createApplicationContext(root as never, { preview: true, logger: false, abortOnError: false });
  try {
    const missing = new Set<string>();
    for (const mod of (app as unknown as { container: Container }).container.getModules().values()) {
      for (const wrapper of mod.providers.values()) {
        const type = wrapper.metatype;
        if (typeof type !== 'function') continue;
        const optional: number[] = Reflect.getMetadata('optional:paramtypes', type) ?? [];
        if (!optional.length) continue;
        const params: unknown[] = Reflect.getMetadata('design:paramtypes', type) ?? [];
        const tokens: Array<{ index: number; param: unknown }> = Reflect.getMetadata('self:paramtypes', type) ?? [];
        const resolved = wrapper.getCtorMetadata?.() ?? [];
        for (const index of optional) {
          const token = tokens.find((t) => t.index === index)?.param ?? params[index];
          if (typeof token === 'function' && !resolved[index])
            missing.add(`${name}: ${type.name} parameter ${index} (${token.name})`);
        }
      }
    }
    return [...missing];
  } finally {
    await app.close();
  }
}

describe('optional dependencies (#1171)', () => {
  // The modules validate the environment on import, and CI's `check` job has no env file:
  // fill the gaps from the example (a variable already set wins), as the e2e job does.
  beforeAll(() => process.loadEnvFile(new URL('../../../.env.example', import.meta.url)));

  it.each([
    ['api', async () => (await import('../src/app.module.js')).AppModule],
    ['worker', async () => (await import('../src/worker.module.js')).WorkerModule],
    ['mcp', async () => (await import('../src/mcp/mcp.module.js')).McpModule],
    ['learner', async () => (await import('../src/learner/learner.module.js')).LearnerModule],
    ['git', async () => (await import('../src/git/git.module.js')).GitModule],
  ])('every class-typed @Optional() dependency resolves in the %s process', async (name, root) => {
    expect(await unresolved(await root(), name)).toEqual([]);
  }, 60_000);
});
