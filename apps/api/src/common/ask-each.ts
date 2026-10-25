/** Decision questions in flight at once. gen-api answers synchronously in ~2.5 s, so a pass is wall-clock bound. */
export const ASK_CONCURRENCY = 8;

/**
 * Ask one question per item, ASK_CONCURRENCY at a time (#530). Nest-free, so
 * the arbiter's and the citation check's call sites test it alone.
 *
 * `answers[i]` is null where the question failed. An error `isFatal` calls
 * fatal (a dead account) stops the asking after the batch in flight, and every
 * item not yet asked stays null too.
 */
export async function askEach<T>(
  items: readonly T[],
  ask: (item: T) => Promise<number>,
  isFatal: (error: unknown) => boolean,
): Promise<{ answers: Array<number | null>; stopped: unknown }> {
  const answers = new Array<number | null>(items.length).fill(null);
  let stopped: unknown = null;
  for (let i = 0; i < items.length && !stopped; i += ASK_CONCURRENCY) {
    await Promise.all(
      items.slice(i, i + ASK_CONCURRENCY).map(async (item, j) => {
        try {
          answers[i + j] = await ask(item);
        } catch (error) {
          if (isFatal(error)) stopped ??= error;
        }
      }),
    );
  }
  return { answers, stopped };
}
