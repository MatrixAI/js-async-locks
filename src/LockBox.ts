import type { ResourceAcquire, ResourceRelease } from '@matrixai/resources';
import type { Lockable, ToString } from './types';
import { withF, withG } from '@matrixai/resources';
import { ErrorAsyncLocksLockBoxConflict } from './errors';

type LockRequest<L extends Lockable> = [
  key: ToString,
  lockConstructor: new () => L,
  ...lockingParams: Parameters<L['lock']>
];

class LockBox<L extends Lockable> implements Lockable {
  protected _locks: Map<string, L> = new Map();

  public lock(...requests: Array<LockRequest<L>>): ResourceAcquire<LockBox<L>> {
    return async () => {
      // Convert to strings
      // This creates a copy of the requests
      let requests_: Array<[string, new () => L, ...Parameters<L['lock']>]> =
        requests.map(([key, ...rest]) =>
          typeof key === 'string' ? [key, ...rest] : [key.toString(), ...rest],
        );
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
      for (const [key, LockConstructor, ...lockingParams] of requests_) {
        let lock = this._locks.get(key);
        if (lock == null) {
          lock = new LockConstructor();
          this._locks.set(key, lock);
        } else {
          // It is possible to swap the lock class, but only after the lock key is released
          if (!(lock instanceof LockConstructor)) {
            throw new ErrorAsyncLocksLockBoxConflict(
              `Lock ${key} is already locked with class ${lock.constructor.name}, which conflicts with class ${LockConstructor.name}`,
            );
          }
        }
        const lockAcquire = lock.lock(...lockingParams);
        let lockRelease: ResourceRelease;
        try {
          [lockRelease] = await lockAcquire();
        } catch (e) {
          // Release all intermediate locks in reverse order
          locks.reverse();
          for (const [key, lockRelease, lock] of locks) {
            await lockRelease();
            if (!lock.isLocked()) {
              this._locks.delete(key);
            }
          }
          throw e;
        }
        locks.push([key, lockRelease, lock]);
      }
      return [
        async () => {
          // Release all locks in reverse order
          locks.reverse();
          for (const [key, lockRelease, lock] of locks) {
            await lockRelease();
            if (!lock.isLocked()) {
              this._locks.delete(key);
            }
          }
        },
        this,
      ];
    };
  }

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

  public isLocked(key?: ToString): boolean {
    if (key == null) {
      for (const lock of this._locks.values()) {
        if (lock.isLocked()) return true;
      }
      return false;
    } else {
      const lock = this._locks.get(key.toString());
      if (lock == null) return false;
      return lock.isLocked();
    }
  }

  public async waitForUnlock(timeout?: number, key?: ToString): Promise<void> {
    if (key == null) {
      const ps: Array<Promise<void>> = [];
      for (const lock of this._locks.values()) {
        ps.push(lock.waitForUnlock(timeout));
      }
      await Promise.all(ps);
    } else {
      const lock = this._locks.get(key.toString());
      if (lock == null) return;
      await lock.waitForUnlock(timeout);
    }
  }

  public async withF<T>(
    ...params: [
      ...requests: Array<LockRequest<L>>,
      f: (lockBox: LockBox<L>) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (lockBox: LockBox<L>) => Promise<T>;
    return withF(
      [this.lock(...(params as Array<LockRequest<L>>))],
      ([lockBox]) => f(lockBox),
    );
  }

  public withG<T, TReturn, TNext>(
    ...params: [
      ...requests: Array<LockRequest<L>>,
      g: (lockBox: LockBox<L>) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      lockBox: LockBox<L>,
    ) => AsyncGenerator<T, TReturn, TNext>;
    return withG(
      [this.lock(...(params as Array<LockRequest<L>>))],
      ([lockBox]) => g(lockBox),
    );
  }
}

export default LockBox;
