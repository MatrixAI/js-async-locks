import type { ResourceRelease } from '@matrixai/resources';
import type RWLockWriter from './RWLockWriter';
import type RWLockReader from './RWLockReader';
import type LockBox from './LockBox';
import type {
  ResourceAcquireCancellable,
  Lockable,
  LockRequest,
  RWLockRequest,
  ContextTimedInput,
} from './types';
import { PromiseCancellable } from '@matrixai/async-cancellable';
import { withF, withG } from '@matrixai/resources';
import * as errors from './errors';

class Monitor<RWLock extends RWLockReader | RWLockWriter> implements Lockable {
  /**
   * Global lock box.
   * Must be shared between all monitors.
   */
  protected lockBox: LockBox<RWLock>;

  /**
   * Lock constructor to be used.
   */
  protected lockConstructor: new () => RWLock;

  /**
   * Global pending locks map.
   * Only used for deadlock detection.
   */
  protected locksPending?: Map<string, { count: number }>;

  /**
   * Monitor specific lock map.
   */
  protected _locks: Map<
    string,
    | { status: 'acquiring'; type: 'read' | 'write' }
    | {
        status: 'acquired';
        type: 'read' | 'write';
        lock: RWLock;
        release: ResourceRelease;
      }
  > = new Map();

  public constructor(
    lockBox: LockBox<RWLock>,
    lockConstructor: new () => RWLock,
    locksPending?: Map<string, { count: number }>,
  ) {
    this.lockBox = lockBox;
    this.lockConstructor = lockConstructor;
    this.locksPending = locksPending;
  }

  get locks(): ReadonlyMap<
    string,
    | { status: 'acquiring'; type: 'read' | 'write' }
    | {
        status: 'acquired';
        type: 'read' | 'write';
        lock: RWLock;
        release: ResourceRelease;
      }
  > {
    return this._locks;
  }

  /**
   * The monitor count is isolated to this monitor.
   * Use the shared lock box if you want to know the global count.
   */
  public get count(): number {
    return this._locks.size;
  }

  /**
   * This checks if this monitor has locked the lock.
   * Use the shared lock box if you want to know if it is globally locked.
   */
  public isLocked(key?: string, type?: 'read' | 'write'): boolean {
    if (key == null) {
      for (const [key, lock] of this._locks.entries()) {
        if (lock.status === 'acquiring') {
          // If pending, get it from the lockbox
          if (this.lockBox.locks.get(key)!.isLocked(type)) return true;
        } else {
          if (lock.lock.isLocked(type)) return true;
        }
      }
      return false;
    } else {
      const lock = this._locks.get(key);
      if (lock === undefined) {
        return false;
      } else {
        if (lock.status === 'acquiring') {
          // If pending, get it from the lockbox
          return this.lockBox.locks.get(key)!.isLocked(type);
        } else {
          return lock.lock.isLocked(type);
        }
      }
    }
  }

  /**
   * Lock a sequence of lock requests.
   * This defaults to using `write` locks the type is not specified.
   * Keys are locked in string sorted order.
   * Locking the same key is idempotent therefore lock re-entrancy is enabled.
   * Keys are automatically unlocked in reverse sorted order in case of rejection.
   * There is no support for lock upgrading or downgrading.
   * Re-entrancy should work concurrently.
   */
  public lock(
    ...params:
      | [
          ...requests: Array<RWLockRequest | string>,
          ctx: Partial<ContextTimedInput>,
        ]
      | [...requests: Array<RWLockRequest | string>]
      | [ctx?: Partial<ContextTimedInput>]
  ): ResourceAcquireCancellable<Monitor<RWLock>> {
    const ctx = (
      !Array.isArray(params[params.length - 1]) &&
      typeof params[params.length - 1] !== 'string'
        ? params.pop()
        : undefined
    ) as Partial<ContextTimedInput> | undefined;
    const requests = params as Array<RWLockRequest | string>;
    return () => {
      let currentP: PromiseCancellable<any>;
      const f = async () => {
        const requests_: Array<LockRequest<RWLock>> = [];
        for (const request of requests) {
          if (Array.isArray(request)) {
            const key = request[0];
            // Default the lock type to `write`
            const lockType =
              typeof request[1] === 'string' ? request[1] : 'write';
            // Each lock request can have its own ctx, if it is `undefined`,
            // it defaults to the method `ctx`.
            const ctx_ =
              (typeof request[1] === 'string' ? request[2] : request[1]) ?? ctx;
            const lock = this._locks.get(key);
            if (lock === undefined) {
              requests_.push([
                key,
                this.lockConstructor,
                lockType,
                ctx_,
              ] as any);
            } else if (lock.type !== lockType) {
              throw new errors.ErrorAsyncLocksMonitorLockType(
                `Cannot change lock type from ${lock.type} to ${lockType}`,
              );
            }
          } else {
            const key = request;
            const lock = this._locks.get(key);
            if (lock === undefined) {
              // Default the lock type to `write` and use the method `ctx`
              requests_.push([key, this.lockConstructor, 'write', ctx] as any);
            } else if (lock.type !== 'write') {
              throw new errors.ErrorAsyncLocksMonitorLockType(
                `Cannot change lock type from ${lock.type} to write`,
              );
            }
          }
        }
        // Duplicates are eliminated, and the returned acquisitions are sorted
        const lockAcquires = this.lockBox.lockMulti(...requests_);
        const lockedKeys: Array<string> = [];
        try {
          for (const [key, lockAcquire, ...lockingParams] of lockAcquires) {
            const lockType = lockingParams[0] as 'read' | 'write';
            const lockAcquireP = lockAcquire();
            currentP = lockAcquireP;
            let lockPendingKey: string | null = null;
            let lockPending: { count: number } | null = null;
            if (this.locksPending != null) {
              // If we cancelling due to deadlock, we will not set the key into
              // the global pending lock map.
              if (this.checkForDeadlock(key, lockType)) {
                lockAcquireP.cancel(
                  new errors.ErrorAsyncLocksMonitorDeadlock(),
                );
              } else {
                [lockPendingKey, lockPending] = this.setPendingLock(
                  key,
                  lockType,
                );
              }
            }
            let lockRelease: ResourceRelease, lock: RWLock | undefined;
            this._locks.set(key, { status: 'acquiring', type: lockType });
            try {
              [lockRelease, lock] = await lockAcquireP;
            } catch (e) {
              // Remove the local acquisition
              this._locks.delete(key);
              throw e;
            } finally {
              if (lockPendingKey !== null && lockPending !== null) {
                this.unsetPendingLock(lockPendingKey, lockPending);
              }
            }
            // The `Map` will maintain insertion order
            // these must be unlocked in reverse order
            // when the transaction is destroyed
            this._locks.set(key, {
              status: 'acquired',
              lock: lock!,
              type: lockingParams[0] as 'read' | 'write',
              release: lockRelease,
            });
            lockedKeys.push(key);
          }
        } catch (e) {
          // Reverse and unlock
          lockedKeys.reverse();
          await this.unlock(...lockedKeys);
          throw e;
        }
        let released = false;
        return [
          async () => {
            if (released) return;
            released = true;
            // Release all locks in reverse order
            lockedKeys.reverse();
            await this.unlock(...lockedKeys);
          },
          this,
        ] as const;
      };
      return PromiseCancellable.from(f(), (signal) => {
        signal.addEventListener(
          'abort',
          () => {
            currentP?.cancel(signal.reason);
          },
          { once: true },
        );
      });
    };
  }

  /**
   * Unlock a sequence of lock keys.
   * Unlocking will be done in the order of the keys.
   * Unlocking can only be done for the keys locked by this monitor.
   * Unlocking the same keys is idempotent.
   */
  public async unlock(...keys: Array<string>): Promise<void> {
    for (const key of keys) {
      const lock = this._locks.get(key);
      if (lock === undefined) continue;
      if (lock.status === 'acquired') {
        // Only unlock acquired keys
        this._locks.delete(key);
        await lock.release();
      }
    }
  }

  public async unlockAll() {
    const lockedKeys = [...this._locks.keys()].reverse();
    await this.unlock(...lockedKeys);
  }

  /**
   * This waits for a lock in this specific monitor.
   * Use the shared lock box if you want globally wait for unlock.
   */
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
      for (const [key, lock] of this._locks.entries()) {
        if (lock.status === 'acquiring') {
          // If pending, get it from the lockbox
          waitPs.push(this.lockBox.locks.get(key)!.waitForUnlock(ctx));
        } else {
          waitPs.push(lock.lock.waitForUnlock(ctx));
        }
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
      if (lock === undefined) return PromiseCancellable.resolve();
      if (lock.status === 'acquiring') {
        return this.lockBox.locks.get(key)!.waitForUnlock(ctx);
      } else {
        return lock.lock.waitForUnlock(ctx);
      }
    }
  }

  public withF<T>(
    ...params: [
      ...(
        | [
            ...requests: Array<RWLockRequest | string>,
            ctx: Partial<ContextTimedInput>,
          ]
        | [...requests: Array<RWLockRequest | string>]
        | [ctx?: Partial<ContextTimedInput>]
      ),
      (monitor: Monitor<RWLock>) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (lockBox: Monitor<RWLock>) => Promise<T>;
    return withF([this.lock(...(params as any))], ([monitor]) => f(monitor));
  }

  public withG<T, TReturn, TNext>(
    ...params: [
      ...(
        | [
            ...requests: Array<RWLockRequest | string>,
            ctx: Partial<ContextTimedInput>,
          ]
        | [...requests: Array<RWLockRequest | string>]
        | [ctx?: Partial<ContextTimedInput>]
      ),
      (monitor: Monitor<RWLock>) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      monitor: Monitor<RWLock>,
    ) => AsyncGenerator<T, TReturn, TNext>;
    return withG([this.lock(...(params as any))], ([monitor]) => g(monitor));
  }

  protected setPendingLock(
    key: string,
    lockType: 'read' | 'write',
  ): [string, { count: number }] {
    if (this.locksPending == null) {
      throw ReferenceError('Cannot set pending lock without pending locks map');
    }
    const lockPendingKey = JSON.stringify([key, lockType]);
    let lockPending = this.locksPending.get(lockPendingKey);
    if (lockPending == null) {
      lockPending = { count: 1 };
      this.locksPending.set(lockPendingKey, lockPending);
    } else {
      lockPending.count += 1;
    }
    return [lockPendingKey, lockPending];
  }

  protected unsetPendingLock(
    lockPendingKey: string,
    lockPending: { count: number },
  ): void {
    if (this.locksPending == null) {
      throw ReferenceError(
        'Cannot unset pending lock without pending locks map',
      );
    }
    lockPending.count -= 1;
    if (lockPending.count === 0) {
      this.locksPending.delete(lockPendingKey);
    }
  }

  protected checkForDeadlock(key: string, lockType: 'read' | 'write'): boolean {
    if (this.locksPending == null) {
      throw ReferenceError(
        'Cannot check for deadlock without pending locks map',
      );
    }
    const lockObj = this.lockBox.locks.get(key);
    if (lockObj != null) {
      if (
        (lockType === 'read' && lockObj.isLocked('write')) ||
        (lockType === 'write' && lockObj.isLocked())
      ) {
        // Check if other monitor's pending lock keys conflict with
        // this monitor's existing held locks.
        for (const lockPendingKey of this.locksPending.keys()) {
          const [lockKeyPending, lockTypePending] = JSON.parse(lockPendingKey);
          const lock = this._locks.get(lockKeyPending);
          if (
            lock != null &&
            (lock.type === 'write' || lockTypePending === 'write')
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

export default Monitor;
