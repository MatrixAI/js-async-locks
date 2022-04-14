import type { MutexInterface } from 'async-mutex';
import type { ResourceAcquire } from '@matrixai/resources';
import type { Lockable } from './types';
import { Mutex, withTimeout } from 'async-mutex';
import { withF, withG } from '@matrixai/resources';
import { sleep, yieldMicro } from './utils';
import { ErrorAsyncLocksTimeout } from './errors';

class Lock implements Lockable {
  protected _lock: Mutex = new Mutex();
  protected _count: number = 0;

  public lock(timeout?: number): ResourceAcquire<Lock> {
    return async () => {
      ++this._count;
      let lock: MutexInterface = this._lock;
      if (timeout != null) {
        lock = withTimeout(this._lock, timeout, new ErrorAsyncLocksTimeout());
      }
      let release: MutexInterface.Releaser;
      try {
        release = await lock.acquire();
      } catch (e) {
        --this._count;
        throw e;
      }
      return [
        async () => {
          --this._count;
          release();
          // Allow semaphore to settle https://github.com/DirtyHairy/async-mutex/issues/54
          await yieldMicro();
        },
        this,
      ];
    };
  }

  public get count(): number {
    return this._count;
  }

  public isLocked(): boolean {
    return this._lock.isLocked();
  }

  public async waitForUnlock(timeout?: number): Promise<void> {
    if (timeout != null) {
      let timedOut = false;
      await Promise.race([
        this._lock.waitForUnlock(),
        sleep(timeout).then(() => {
          timedOut = true;
        }),
      ]);
      if (timedOut) {
        throw new ErrorAsyncLocksTimeout();
      }
    } else {
      await this._lock.waitForUnlock();
    }
  }

  public async withF<T>(
    ...params: [...([timeout: number] | []), (lock: Lock) => Promise<T>]
  ): Promise<T> {
    const f = params.pop() as (lock: Lock) => Promise<T>;
    const timeout = params[0] as number;
    return withF([this.lock(timeout)], ([lock]) => f(lock));
  }

  public withG<T, TReturn, TNext>(
    ...params: [
      ...([timeout: number] | []),
      (lock: Lock) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (lock: Lock) => AsyncGenerator<T, TReturn, TNext>;
    const timeout = params[0] as number;
    return withG([this.lock(timeout)], ([lock]) => g(lock));
  }
}

export default Lock;
