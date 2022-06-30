import type { ResourceAcquire, ResourceRelease } from '@matrixai/resources';
import type {
  ToString,
  Lockable,
  MultiLockRequest,
  MultiLockAcquire,
  MultiLockAcquired,
} from './types';
import { withF, withG } from '@matrixai/resources';
import { ErrorAsyncLocksLockBoxConflict } from './errors';

class LockBox<L extends Lockable = Lockable> implements Lockable {
  protected _locks: Map<string, L> = new Map();

  public lock(
    ...requests: Array<MultiLockRequest<L>>
  ): ResourceAcquire<LockBox<L>> {
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
      try {
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
          const [lockRelease] = await lockAcquire();
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
      ];
    };
  }

  public lockMulti(
    ...requests: Array<MultiLockRequest<L>>
  ): Array<MultiLockAcquire<L>> {
    // Convert to strings
    // This creates a copy of the requests
    let requests_: Array<
      [string, ToString, new () => L, ...Parameters<L['lock']>]
    > = requests.map(([key, ...rest]) =>
      typeof key === 'string'
        ? [key, key, ...rest]
        : [key.toString(), key, ...rest],
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
    const lockAcquires: Array<MultiLockAcquire<L>> = [];
    for (const [key, keyOrig, LockConstructor, ...lockingParams] of requests_) {
      const lockAcquire: ResourceAcquire<L> = async () => {
        let lock = this._locks.get(key);
        let lockRelease: ResourceRelease;
        try {
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
          [lockRelease] = await lockAcquire();
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
        ];
      };
      lockAcquires.push([keyOrig, lockAcquire, ...lockingParams]);
    }
    return lockAcquires;
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

  public isLocked(
    key?: ToString,
    ...params: Parameters<L['isLocked']>
  ): boolean {
    if (key == null) {
      for (const lock of this._locks.values()) {
        if (lock.isLocked(...params)) return true;
      }
      return false;
    } else {
      const lock = this._locks.get(key.toString());
      if (lock == null) return false;
      return lock.isLocked(...params);
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
      ...requests: Array<MultiLockRequest<L>>,
      f: (lockBox: LockBox<L>) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (lockBox: LockBox<L>) => Promise<T>;
    return withF(
      [this.lock(...(params as Array<MultiLockRequest<L>>))],
      ([lockBox]) => f(lockBox),
    );
  }

  public async withMultiF<T>(
    ...params: [
      ...requests: Array<MultiLockRequest<L>>,
      f: (multiLocks: Array<MultiLockAcquired<L>>) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (
      multiLocks: Array<MultiLockAcquired<L>>,
    ) => Promise<T>;
    const lockAcquires = this.lockMulti(
      ...(params as Array<MultiLockRequest<L>>),
    );

    const lockAcquires_: Array<ResourceAcquire<MultiLockAcquired<L>>> =
      lockAcquires.map(
        ([key, lockAcquire, ...lockingParams]) =>
          (...r) =>
            lockAcquire(...r).then(
              ([lockRelease, lock]) =>
                [lockRelease, [key, lock, ...lockingParams]] as [
                  ResourceRelease,
                  MultiLockAcquired<L>,
                ],
            ),
      );
    return withF(lockAcquires_, f);
  }

  public withG<T, TReturn, TNext>(
    ...params: [
      ...requests: Array<MultiLockRequest<L>>,
      g: (lockBox: LockBox<L>) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      lockBox: LockBox<L>,
    ) => AsyncGenerator<T, TReturn, TNext>;
    return withG(
      [this.lock(...(params as Array<MultiLockRequest<L>>))],
      ([lockBox]) => g(lockBox),
    );
  }

  public withMultiG<T, TReturn, TNext>(
    ...params: [
      ...requests: Array<MultiLockRequest<L>>,
      g: (
        multiLocks: Array<MultiLockAcquired<L>>,
      ) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ) {
    const g = params.pop() as (
      multiLocks: Array<MultiLockAcquired<L>>,
    ) => AsyncGenerator<T, TReturn, TNext>;
    const lockAcquires = this.lockMulti(
      ...(params as Array<MultiLockRequest<L>>),
    );
    const lockAcquires_: Array<ResourceAcquire<MultiLockAcquired<L>>> =
      lockAcquires.map(
        ([key, lockAcquire, ...lockingParams]) =>
          (...r) =>
            lockAcquire(...r).then(
              ([lockRelease, lock]) =>
                [lockRelease, [key, lock, ...lockingParams]] as [
                  ResourceRelease,
                  MultiLockAcquired<L>,
                ],
            ),
      );
    return withG(lockAcquires_, g);
  }
}

export default LockBox;
