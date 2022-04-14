import type { MutexInterface } from 'async-mutex';
import type { ResourceAcquire } from '@matrixai/resources';
import type { Lockable } from './types';
import { Mutex, withTimeout } from 'async-mutex';
import { withF, withG } from '@matrixai/resources';
import { sleep, yieldMicro } from './utils';
import { ErrorAsyncLocksTimeout } from './errors';

/**
 * Read-preferring read write lock
 */
class RWLockReader implements Lockable {
  protected _readerCount: number = 0;
  protected _writerCount: number = 0;
  protected _lock: Mutex = new Mutex();
  protected release: MutexInterface.Releaser;

  public lock(
    type: 'read' | 'write',
    timeout?: number,
  ): ResourceAcquire<RWLockReader> {
    switch (type) {
      case 'read':
        return this.read(timeout);
      case 'write':
        return this.write(timeout);
    }
  }

  public read(timeout?: number): ResourceAcquire<RWLockReader> {
    return async () => {
      const readerCount = ++this._readerCount;
      // The first reader locks
      if (readerCount === 1) {
        let lock: MutexInterface = this._lock;
        if (timeout != null) {
          lock = withTimeout(this._lock, timeout, new ErrorAsyncLocksTimeout());
        }
        try {
          this.release = await lock.acquire();
        } catch (e) {
          --this._readerCount;
          throw e;
        }
      } else {
        // Yield for the first reader to finish locking
        await yieldMicro();
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
      let lock: MutexInterface = this._lock;
      if (timeout != null) {
        lock = withTimeout(this._lock, timeout, new ErrorAsyncLocksTimeout());
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

  public get count(): number {
    return this.readerCount + this.writerCount;
  }

  public get readerCount(): number {
    return this._readerCount;
  }

  public get writerCount(): number {
    return this._writerCount;
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
    ...params: [
      ...(
        | [type: 'read' | 'write', timeout: number]
        | [type: 'read' | 'write']
        | []
      ),
      (lock: RWLockReader) => Promise<T>,
    ]
  ): Promise<T> {
    const type = params.shift() as 'read' | 'write';
    switch (type) {
      case 'read':
        return this.withReadF(...(params as any));
      case 'write':
        return this.withWriteF(...(params as any));
    }
  }

  public async withReadF<T>(
    ...params: [...([timeout: number] | []), (lock: RWLockReader) => Promise<T>]
  ): Promise<T> {
    const f = params.pop() as (lock: RWLockReader) => Promise<T>;
    const timeout = params[0] as number;
    return withF([this.read(timeout)], ([lock]) => f(lock));
  }

  public async withWriteF<T>(
    ...params: [...([timeout: number] | []), (lock: RWLockReader) => Promise<T>]
  ): Promise<T> {
    const f = params.pop() as (lock: RWLockReader) => Promise<T>;
    const timeout = params[0] as number;
    return withF([this.write(timeout)], ([lock]) => f(lock));
  }

  public withG<T, TReturn, TNext>(
    ...params: [
      ...(
        | [type: 'read' | 'write', timeout: number]
        | [type: 'read' | 'write']
        | []
      ),
      (lock: RWLockReader) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const type = params.shift() as 'read' | 'write';
    switch (type) {
      case 'read':
        return this.withReadG(...(params as any));
      case 'write':
        return this.withWriteG(...(params as any));
    }
  }

  public withReadG<T, TReturn, TNext>(
    ...params: [
      ...([timeout: number] | []),
      (lock: RWLockReader) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      lock: RWLockReader,
    ) => AsyncGenerator<T, TReturn, TNext>;
    const timeout = params[0] as number;
    return withG([this.read(timeout)], ([lock]) => g(lock));
  }

  public withWriteG<T, TReturn, TNext>(
    ...params: [
      ...([timeout: number] | []),
      (lock: RWLockReader) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      lock: RWLockReader,
    ) => AsyncGenerator<T, TReturn, TNext>;
    const timeout = params[0] as number;
    return withG([this.write(timeout)], ([lock]) => g(lock));
  }
}

export default RWLockReader;
