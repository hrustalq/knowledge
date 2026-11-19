import { AsyncLocalStorage } from 'node:async_hooks';

const scopes = new AsyncLocalStorage<Record<string, number>>();

/** Open an isolated timing scope for one operation. */
export function TimingScope(): MethodDecorator {
  return (_target, _key, descriptor) => {
    const original = descriptor.value as (
      this: unknown,
      ...args: unknown[]
    ) => unknown;
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      return scopes.run({}, () => original.apply(this, args));
    } as never;
  };
}

/** Add one method's duration to the active scope; repeated calls accumulate. */
export function Timed(stage: string): MethodDecorator {
  return (_target, _key, descriptor) => {
    const original = descriptor.value as (
      this: unknown,
      ...args: unknown[]
    ) => unknown;
    descriptor.value = function (this: unknown, ...args: unknown[]) {
      const started = process.hrtime.bigint();
      const record = () => {
        const scope = scopes.getStore();
        if (scope)
          scope[stage] =
            (scope[stage] ?? 0) +
            Number(process.hrtime.bigint() - started) / 1e6;
      };
      try {
        const result = original.apply(this, args);
        if (result instanceof Promise) return result.finally(record);
        record();
        return result;
      } catch (error) {
        record();
        throw error;
      }
    } as never;
  };
}

export function currentTimings(): Record<string, number> {
  return { ...scopes.getStore() };
}
