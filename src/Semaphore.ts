import type { SemaphoreInterface } from 'async-mutex';
import type { ResourceAcquire } from '@matrixai/resources';
import type { Lockable } from './types';
import { Semaphore as _Semaphore, withTimeout } from 'async-mutex';
import { withF, withG } from '@matrixai/resources';
import { sleep, yieldMicro } from './utils';
import {
  ErrorAsyncLocksTimeout,
  ErrorAsyncLocksSemaphoreLimit,
} from './errors';

class Semaphore implements Lockable {
  protected _semaphore: _Semaphore;
  protected _count: number = 0;

  constructor(limit: number) {
    if (limit < 1) {
      throw new ErrorAsyncLocksSemaphoreLimit();
    }
    this._semaphore = new _Semaphore(limit);
  }

  public lock(timeout?: number): ResourceAcquire<Semaphore> {
    return async () => {
      ++this._count;
      let semaphore: SemaphoreInterface = this._semaphore;
      if (timeout != null) {
        semaphore = withTimeout(
          this._semaphore,
          timeout,
          new ErrorAsyncLocksTimeout(),
        );
      }
      let release: SemaphoreInterface.Releaser;
      try {
        [, release] = await semaphore.acquire();
      } catch (e) {
        --this._count;
        throw e;
      }
      let released = false;
      return [
        async () => {
          if (released) return;
          released = true;
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
    return this._semaphore.isLocked();
  }

  public async waitForUnlock(timeout?: number): Promise<void> {
    if (timeout != null) {
      let timedOut = false;
      await Promise.race([
        this._semaphore.waitForUnlock(),
        sleep(timeout).then(() => {
          timedOut = true;
        }),
      ]);
      if (timedOut) {
        throw new ErrorAsyncLocksTimeout();
      }
    } else {
      await this._semaphore.waitForUnlock();
    }
  }

  public async withF<T>(
    ...params: [
      ...([timeout: number] | []),
      (semaphore: Semaphore) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (semaphore: Semaphore) => Promise<T>;
    const timeout = params[0] as number;
    return withF([this.lock(timeout)], ([semaphore]) => f(semaphore));
  }

  public withG<T, TReturn, TNext>(
    ...params: [
      ...([timeout: number] | []),
      (semaphore: Semaphore) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      semaphore: Semaphore,
    ) => AsyncGenerator<T, TReturn, TNext>;
    const timeout = params[0] as number;
    return withG([this.lock(timeout)], ([semaphore]) => g(semaphore));
  }
}

export default Semaphore;
