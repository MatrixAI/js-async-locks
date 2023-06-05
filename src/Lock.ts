import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type {
  ResourceAcquireCancellable,
  Lockable,
  ContextTimedInput,
} from './types';
import { withF, withG } from '@matrixai/resources';
import Semaphore from './Semaphore';

class Lock implements Lockable {
  protected semaphore: Semaphore = new Semaphore(1);

  public get count(): number {
    return this.semaphore.count;
  }

  public isLocked(): boolean {
    return this.semaphore.isLocked();
  }

  public lock(
    ctx?: Partial<ContextTimedInput>,
  ): ResourceAcquireCancellable<Lock> {
    const acquire = this.semaphore.lock(1, ctx);
    return () => {
      const acquireP = acquire();
      return acquireP.then(
        ([release]) => [release, this],
        undefined,
        (signal) => {
          // Propagate cancellation to `acquireP`
          signal.addEventListener(
            'abort',
            () => {
              acquireP.cancel(signal.reason);
            },
            { once: true },
          );
        },
      );
    };
  }

  public waitForUnlock(
    ctx?: Partial<ContextTimedInput>,
  ): PromiseCancellable<void> {
    return this.semaphore.waitForUnlock(1, ctx);
  }

  public withF<T>(
    ...params: [
      ...([ctx?: Partial<ContextTimedInput>] | []),
      (lock: Lock) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (lock: Lock) => Promise<T>;
    return withF([this.lock(...(params as any))], ([lock]) => f(lock));
  }

  public withG<T, TReturn, TNext>(
    ...params: [
      ...([ctx?: Partial<ContextTimedInput>] | []),
      (lock: Lock) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (lock: Lock) => AsyncGenerator<T, TReturn, TNext>;
    return withG([this.lock(...(params as any))], ([lock]) => g(lock));
  }
}

export default Lock;
