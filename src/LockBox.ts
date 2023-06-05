import type { ResourceAcquire, ResourceRelease } from '@matrixai/resources';
import type {
  ResourceAcquireCancellable,
  Lockable,
  LockRequest,
  LockAcquireCancellable,
  LockAcquired,
  ContextTimed,
  ContextTimedInput,
} from './types';
import { PromiseCancellable } from '@matrixai/async-cancellable';
import { withF, withG } from '@matrixai/resources';
import * as utils from './utils';
import * as errors from './errors';

class LockBox<L extends Lockable = Lockable> implements Lockable {
  protected _locks: Map<string, L> = new Map();

  get locks(): ReadonlyMap<string, L> {
    return this._locks;
  }

  public get count(): number {
    let count = 0;
    for (const lock of this._locks.values()) {
      count += lock.count;
    }
    return count;
  }

  public isLocked(key?: string, ...params: Parameters<L['isLocked']>): boolean {
    if (key == null) {
      for (const lock of this._locks.values()) {
        if (lock.isLocked(...params)) return true;
      }
      return false;
    } else {
      const lock = this._locks.get(key);
      if (lock == null) return false;
      return lock.isLocked(...params);
    }
  }

  public lock(
    ...params:
      | [...requests: Array<LockRequest<L>>, ctx: Partial<ContextTimedInput>]
      | [...requests: Array<LockRequest<L>>]
      | [ctx?: Partial<ContextTimedInput>]
  ): ResourceAcquireCancellable<LockBox<L>> {
    let ctx = (
      !Array.isArray(params[params.length - 1]) ? params.pop() : undefined
    ) as Partial<ContextTimedInput> | undefined;
    ctx = ctx != null ? { ...ctx } : {};
    const requests = params as Array<LockRequest<L>>;
    return () => {
      return utils.setupTimedCancellable(
        async (ctx: ContextTimed) => {
          // This creates a copy of the requests
          let requests_ = [...requests];
          // Sort to ensure lock hierarchy
          requests_.sort(([key1], [key2]) => {
            // Deterministic string comparison according to 16-bit code units
            if (key1 < key2) return -1;
            if (key1 > key2) return 1;
            return 0;
          });
          // Avoid duplicate locking
          requests_ = requests_.filter(
            ([key], i, arr) => i === 0 || key !== arr[i - 1][0],
          );
          const locks: Array<[string, ResourceRelease, L]> = [];
          try {
            for (const [key, LockConstructor, ...lockingParams] of requests_) {
              let lock = this._locks.get(key);
              if (lock == null) {
                lock = new LockConstructor();
                this._locks.set(key, lock);
              } else {
                // It is possible to swap the lock class, but only after the lock key is released
                if (!(lock instanceof LockConstructor)) {
                  throw new errors.ErrorAsyncLocksLockBoxConflict(
                    `Lock ${key} is already locked with class ${lock.constructor.name}, which conflicts with class ${LockConstructor.name}`,
                  );
                }
              }
              const lockAcquire = lock.lock(...lockingParams, ctx);
              const lockAcquireP = lockAcquire();
              const [lockRelease] = await lockAcquireP;
              locks.push([key, lockRelease, lock]);
            }
          } catch (e) {
            // Release all intermediate locks in reverse order
            locks.reverse();
            for (const [key, lockRelease, lock] of locks) {
              await lockRelease();
              // If it is still locked, then it is held by a different context
              // only delete if no contexts are locking the lock
              if (!lock.isLocked()) {
                this._locks.delete(key);
              }
            }
            throw e;
          }
          let released = false;
          return [
            async () => {
              if (released) return;
              released = true;
              // Release all locks in reverse order
              locks.reverse();
              for (const [key, lockRelease, lock] of locks) {
                await lockRelease();
                // If it is still locked, then it is held by a different context
                // only delete if no contexts are locking the lock
                if (!lock.isLocked()) {
                  this._locks.delete(key);
                }
              }
            },
            this,
          ] as const;
        },
        true,
        Infinity,
        errors.ErrorAsyncLocksTimeout,
        ctx!,
        [],
      );
    };
  }

  public lockMulti(
    ...requests: Array<LockRequest<L>>
  ): Array<LockAcquireCancellable<L>> {
    // This creates a copy of the requests
    let requests_ = [...requests];
    // Sort to ensure lock hierarchy
    requests_.sort(([key1], [key2]) => {
      // Deterministic string comparison according to 16-bit code units
      if (key1 < key2) return -1;
      if (key1 > key2) return 1;
      return 0;
    });
    // Avoid duplicate locking
    requests_ = requests_.filter(
      ([key], i, arr) => i === 0 || key !== arr[i - 1][0],
    );
    const lockAcquires: Array<LockAcquireCancellable<L>> = [];
    for (const [key, LockConstructor, ...lockingParams] of requests_) {
      const lockAcquire: ResourceAcquireCancellable<L> = () => {
        let currentP: PromiseCancellable<any>;
        const f = async () => {
          let lock = this._locks.get(key);
          let lockRelease: ResourceRelease;
          try {
            if (lock == null) {
              lock = new LockConstructor();
              this._locks.set(key, lock);
            } else {
              // It is possible to swap the lock class, but only after the lock key is released
              if (!(lock instanceof LockConstructor)) {
                throw new errors.ErrorAsyncLocksLockBoxConflict(
                  `Lock ${key} is already locked with class ${lock.constructor.name}, which conflicts with class ${LockConstructor.name}`,
                );
              }
            }
            const lockAcquire = lock.lock(...lockingParams);
            const lockAcquireP = lockAcquire();
            currentP = lockAcquireP;
            [lockRelease] = await lockAcquireP;
          } catch (e) {
            // If it is still locked, then it is held by a different context
            // only delete if no contexts are locking the lock
            if (!lock!.isLocked()) {
              this._locks.delete(key);
            }
            throw e;
          }
          let released = false;
          return [
            async () => {
              if (released) return;
              released = true;
              await lockRelease();
              // If it is still locked, then it is held by a different context
              // only delete if no contexts are locking the lock
              if (!lock!.isLocked()) {
                this._locks.delete(key);
              }
            },
            lock,
          ] as const;
        };
        return PromiseCancellable.from(f(), (signal) => {
          signal.addEventListener(
            'abort',
            () => {
              currentP.cancel(signal.reason);
            },
            { once: true },
          );
        });
      };
      lockAcquires.push([key, lockAcquire, ...lockingParams]);
    }
    return lockAcquires;
  }

  public waitForUnlock(
    ...params:
      | [key?: string, ctx?: Partial<ContextTimedInput>]
      | [key?: string]
      | [ctx?: Partial<ContextTimedInput>]
      | []
  ): PromiseCancellable<void> {
    const key =
      params.length === 2
        ? params[0]
        : typeof params[0] === 'string'
        ? params[0]
        : undefined;
    const ctx =
      params.length === 2
        ? params[1]
        : typeof params[0] !== 'string'
        ? params[0]
        : undefined;
    if (key == null) {
      const waitPs: Array<PromiseCancellable<void>> = [];
      for (const lock of this._locks.values()) {
        waitPs.push(lock.waitForUnlock(ctx));
      }
      const waitP = Promise.all(waitPs).then(() => {});
      return PromiseCancellable.from(waitP, (signal) => {
        signal.addEventListener(
          'abort',
          () => {
            waitPs.reverse();
            for (const waitP of waitPs) {
              waitP.cancel(signal.reason);
            }
          },
          { once: true },
        );
      });
    } else {
      const lock = this._locks.get(key);
      if (lock == null) return PromiseCancellable.resolve();
      return lock.waitForUnlock(ctx);
    }
  }

  public withF<T>(
    ...params: [
      ...(
        | [...requests: Array<LockRequest<L>>, ctx: Partial<ContextTimedInput>]
        | [...requests: Array<LockRequest<L>>]
        | [ctx?: Partial<ContextTimedInput>]
      ),
      (lockBox: LockBox<L>) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (lockBox: LockBox<L>) => Promise<T>;
    return withF([this.lock(...(params as any))], ([lockBox]) => f(lockBox));
  }

  public withMultiF<T>(
    ...params: [
      ...requests: Array<LockRequest<L>>,
      f: (multiLocks: Array<LockAcquired<L>>) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (
      multiLocks: Array<LockAcquired<L>>,
    ) => Promise<T>;
    const lockAcquires = this.lockMulti(...(params as Array<LockRequest<L>>));
    const lockAcquires_: Array<ResourceAcquire<LockAcquired<L>>> =
      lockAcquires.map(
        ([key, lockAcquire, ...lockingParams]) =>
          (...r) =>
            lockAcquire(...r).then(
              ([lockRelease, lock]) =>
                [lockRelease, [key, lock, ...lockingParams]] as [
                  ResourceRelease,
                  LockAcquired<L>,
                ],
            ),
      );
    return withF(lockAcquires_, f);
  }

  public withG<T, TReturn, TNext>(
    ...params: [
      ...(
        | [...requests: Array<LockRequest<L>>, ctx: Partial<ContextTimedInput>]
        | [...requests: Array<LockRequest<L>>]
        | [ctx?: Partial<ContextTimedInput>]
      ),
      (lockBox: LockBox<L>) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      lockBox: LockBox<L>,
    ) => AsyncGenerator<T, TReturn, TNext>;
    return withG([this.lock(...(params as any))], ([lockBox]) => g(lockBox));
  }

  public withMultiG<T, TReturn, TNext>(
    ...params: [
      ...requests: Array<LockRequest<L>>,
      g: (
        multiLocks: Array<LockAcquired<L>>,
      ) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ) {
    const g = params.pop() as (
      multiLocks: Array<LockAcquired<L>>,
    ) => AsyncGenerator<T, TReturn, TNext>;
    const lockAcquires = this.lockMulti(...(params as Array<LockRequest<L>>));
    const lockAcquires_: Array<ResourceAcquire<LockAcquired<L>>> =
      lockAcquires.map(
        ([key, lockAcquire, ...lockingParams]) =>
          (...r) =>
            lockAcquire(...r).then(
              ([lockRelease, lock]) =>
                [lockRelease, [key, lock, ...lockingParams]] as [
                  ResourceRelease,
                  LockAcquired<L>,
                ],
            ),
      );
    return withG(lockAcquires_, g);
  }
}

export default LockBox;
