/**
 * The seam between RxJS and Vue reactivity, in both directions.
 *
 * Streams own the *timing* — debounce, one pass per animation frame, dropping
 * repeats — and Vue owns the rendering. Everything here is subscription
 * plumbing tied to the current effect scope, so a stream opened in `setup()`
 * closes with the component and never outlives it.
 *
 * Deliberately not `@vueuse/rxjs`: the editor needs these three functions, and
 * the difference is thirty lines against a dependency.
 */
import { getCurrentScope, onScopeDispose, shallowRef, watch, type ShallowRef, type WatchSource } from 'vue'
import { Observable, type Subscription } from 'rxjs'

/**
 * A Vue source as a stream. `immediate` replays the current value on subscribe,
 * which is what a stream derived from state (rather than from events) wants.
 */
export function fromWatch<T>(
  source: WatchSource<T>,
  options: { immediate?: boolean; deep?: boolean } = {},
): Observable<T> {
  return new Observable<T>((subscriber) => {
    const stop = watch(source, (value) => subscriber.next(value), {
      immediate: options.immediate ?? true,
      deep: options.deep ?? false,
      // `sync`: the stream applies its own timing, and a pre-flush watcher would
      // quietly add a second, invisible debounce in front of it.
      flush: 'sync',
    })
    return stop
  })
}

/** Unsubscribe when the current scope (usually a component) is disposed. */
export function useSubscription(subscription: Subscription): Subscription {
  if (getCurrentScope()) onScopeDispose(() => subscription.unsubscribe())
  return subscription
}

/**
 * A stream's latest value as a shallow ref. Shallow because the values are
 * snapshots — replaced whole, never mutated — so deep tracking would only cost.
 */
export function useObservable<T>(source: Observable<T>, initial: T): Readonly<ShallowRef<T>> {
  const value = shallowRef(initial)
  useSubscription(source.subscribe((next) => (value.value = next)))
  return value
}
