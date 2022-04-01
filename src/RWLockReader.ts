import type { MutexInterface } from 'async-mutex';
import type { ResourceAcquire } from '@matrixai/resources';
import { Mutex, withTimeout } from 'async-mutex';
import { withF, withG } from '@matrixai/resources';
import { sleep, yieldMicro } from './utils';
import { ErrorAsyncLocksTimeout } from './errors';

/**
 * Read-preferring read write lock
 */
class RWLockReader {
  protected _readerCount: number = 0;
  protected _writerCount: number = 0;
  protected lock: Mutex = new Mutex();
  protected release: MutexInterface.Releaser;

  public read(timeout?: number): ResourceAcquire<RWLockReader> {
    return async () => {
      const readerCount = ++this._readerCount;
      // The first reader locks
      if (readerCount === 1) {
        let lock: MutexInterface = this.lock;
        if (timeout != null) {
          lock = withTimeout(this.lock, timeout, new ErrorAsyncLocksTimeout());
        }
        try {
          this.release = await lock.acquire();
        } catch (e) {
          --this._readerCount;
          throw e;
        }
      }
      return [
        async () => {
          const readerCount = --this._readerCount;
          // The last reader unlocks
          if (readerCount === 0) {
            this.release();
          }
          // Allow semaphore to settle https://github.com/DirtyHairy/async-mutex/issues/54
          await yieldMicro();
        },
        this,
      ];
    };
  }

  public write(timeout?: number): ResourceAcquire<RWLockReader> {
    return async () => {
      ++this._writerCount;
      let lock: MutexInterface = this.lock;
      if (timeout != null) {
        lock = withTimeout(this.lock, timeout, new ErrorAsyncLocksTimeout());
      }
      let release: MutexInterface.Releaser;
      try {
        release = await lock.acquire();
      } catch (e) {
        --this._writerCount;
        throw e;
      }
      return [
        async () => {
          release();
          --this._writerCount;
          // Allow semaphore to settle https://github.com/DirtyHairy/async-mutex/issues/54
          await yieldMicro();
        },
        this,
      ];
    };
  }

  public get readerCount(): number {
    return this._readerCount;
  }

  public get writerCount(): number {
    return this._writerCount;
  }

  public isLocked(): boolean {
    return this.lock.isLocked();
  }

  public async waitForUnlock(timeout?: number): Promise<void> {
    if (timeout != null) {
      let timedOut = false;
      await Promise.race([
        this.lock.waitForUnlock(),
        sleep(timeout).then(() => {
          timedOut = true;
        }),
      ]);
      if (timedOut) {
        throw new ErrorAsyncLocksTimeout();
      }
    } else {
      await this.lock.waitForUnlock();
    }
  }

  public async withReadF<T>(
    f: (resources: [RWLockReader]) => Promise<T>,
    timeout?: number,
  ): Promise<T> {
    return withF([this.read(timeout)], f);
  }

  public async withWriteF<T>(
    f: (resources: [RWLockReader]) => Promise<T>,
    timeout?: number,
  ): Promise<T> {
    return withF([this.write(timeout)], f);
  }

  public withReadG<T, TReturn, TNext>(
    g: (resources: [RWLockReader]) => AsyncGenerator<T, TReturn, TNext>,
    timeout?: number,
  ): AsyncGenerator<T, TReturn, TNext> {
    return withG([this.read(timeout)], g);
  }

  public withWriteG<T, TReturn, TNext>(
    g: (resources: [RWLockReader]) => AsyncGenerator<T, TReturn, TNext>,
    timeout?: number,
  ): AsyncGenerator<T, TReturn, TNext> {
    return withG([this.write(timeout)], g);
  }
}

export default RWLockReader;
