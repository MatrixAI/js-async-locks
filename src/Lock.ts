import type { MutexInterface } from 'async-mutex';
import type { ResourceAcquire } from '@matrixai/resources';
import { Mutex, withTimeout } from 'async-mutex';
import { withF, withG } from '@matrixai/resources';
import { sleep, yieldMicro } from './utils';
import { ErrorAsyncLocksTimeout } from './errors';

class Lock {
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
    f: (resources: [Lock]) => Promise<T>,
    timeout?: number,
  ): Promise<T> {
    return withF([this.lock(timeout)], f);
  }

  public withG<T, TReturn, TNext>(
    g: (resources: [Lock]) => AsyncGenerator<T, TReturn, TNext>,
    timeout?: number,
  ): AsyncGenerator<T, TReturn, TNext> {
    return withG([this.lock(timeout)], g);
  }
}

export default Lock;
