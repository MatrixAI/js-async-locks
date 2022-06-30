import type { MutexInterface } from 'async-mutex';
import type { ResourceAcquire } from '@matrixai/resources';
import type { Lockable } from './types';
import { performance } from 'perf_hooks';
import { Mutex, withTimeout } from 'async-mutex';
import { withF, withG } from '@matrixai/resources';
import { sleep, yieldMicro } from './utils';
import { ErrorAsyncLocksTimeout } from './errors';

/**
 * Write-preferring read write lock
 */
class RWLockWriter implements Lockable {
  protected readersLock: Mutex = new Mutex();
  protected writersLock: Mutex = new Mutex();
  protected readersRelease: MutexInterface.Releaser;
  protected readerCountBlocked: number = 0;
  protected _readerCount: number = 0;
  protected _writerCount: number = 0;

  public lock(
    type: 'read' | 'write' = 'write',
    timeout?: number,
  ): ResourceAcquire<RWLockWriter> {
    switch (type) {
      case 'read':
        return this.read(timeout);
      case 'write':
        return this.write(timeout);
    }
  }

  public read(timeout?: number): ResourceAcquire<RWLockWriter> {
    return async () => {
      const t1 = performance.now();
      if (this._writerCount > 0) {
        ++this.readerCountBlocked;
        if (timeout != null) {
          let timedOut = false;
          await Promise.race([
            this.writersLock.waitForUnlock(),
            sleep(timeout).then(() => {
              timedOut = true;
            }),
          ]);
          if (timedOut) {
            --this.readerCountBlocked;
            throw new ErrorAsyncLocksTimeout();
          }
        } else {
          await this.writersLock.waitForUnlock();
        }
        --this.readerCountBlocked;
      }
      const readerCount = ++this._readerCount;
      // The first reader locks
      if (readerCount === 1) {
        let readersLock: MutexInterface = this.readersLock;
        if (timeout != null) {
          timeout = timeout - (performance.now() - t1);
          readersLock = withTimeout(
            this.readersLock,
            timeout,
            new ErrorAsyncLocksTimeout(),
          );
        }
        try {
          this.readersRelease = await readersLock.acquire();
        } catch (e) {
          --this._readerCount;
          throw e;
        }
      } else {
        // Yield for the first reader to finish locking
        await yieldMicro();
      }
      let released = false;
      return [
        async () => {
          if (released) return;
          released = true;
          const readerCount = --this._readerCount;
          // The last reader unlocks
          if (readerCount === 0) {
            this.readersRelease();
            // Allow semaphore to settle https://github.com/DirtyHairy/async-mutex/issues/54
            await yieldMicro();
          }
        },
        this,
      ];
    };
  }

  public write(timeout?: number): ResourceAcquire<RWLockWriter> {
    return async () => {
      ++this._writerCount;
      let writersLock: MutexInterface = this.writersLock;
      if (timeout != null) {
        writersLock = withTimeout(
          this.writersLock,
          timeout,
          new ErrorAsyncLocksTimeout(),
        );
      }
      const t1 = performance.now();
      let writersRelease: MutexInterface.Releaser;
      try {
        writersRelease = await writersLock.acquire();
      } catch (e) {
        --this._writerCount;
        throw e;
      }
      let readersLock: MutexInterface = this.readersLock;
      if (timeout != null) {
        timeout = timeout - (performance.now() - t1);
        readersLock = withTimeout(
          this.readersLock,
          timeout,
          new ErrorAsyncLocksTimeout(),
        );
      }
      try {
        this.readersRelease = await readersLock.acquire();
      } catch (e) {
        writersRelease();
        --this._writerCount;
        // Allow semaphore to settle https://github.com/DirtyHairy/async-mutex/issues/54
        await yieldMicro();
        throw e;
      }
      let released = false;
      return [
        async () => {
          if (released) return;
          released = true;
          this.readersRelease();
          writersRelease();
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
    return this._readerCount + this.readerCountBlocked;
  }

  public get writerCount(): number {
    return this._writerCount;
  }

  /**
   * Check if locked
   * If passed `type`, it will also check that the active lock is of that type
   */
  public isLocked(type?: 'read' | 'write'): boolean {
    if (type === 'read') {
      return this.readersLock.isLocked();
    } else if (type === 'write') {
      return this.writersLock.isLocked();
    } else {
      return this.readersLock.isLocked() || this.writersLock.isLocked();
    }
  }

  public async waitForUnlock(timeout?: number): Promise<void> {
    if (timeout != null) {
      let timedOut = false;
      await Promise.race([
        Promise.all([
          this.readersLock.waitForUnlock(),
          this.writersLock.waitForUnlock(),
        ]),
        sleep(timeout).then(() => {
          timedOut = true;
        }),
      ]);
      if (timedOut) {
        throw new ErrorAsyncLocksTimeout();
      }
    } else {
      await Promise.all([
        this.readersLock.waitForUnlock(),
        this.writersLock.waitForUnlock(),
      ]);
    }
  }

  public async withF<T>(
    ...params: [
      ...(
        | [type: 'read' | 'write', timeout: number]
        | [type: 'read' | 'write']
        | []
      ),
      (lock: RWLockWriter) => Promise<T>,
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
    ...params: [...([timeout: number] | []), (lock: RWLockWriter) => Promise<T>]
  ): Promise<T> {
    const f = params.pop() as (lock: RWLockWriter) => Promise<T>;
    const timeout = params[0] as number;
    return withF([this.read(timeout)], ([lock]) => f(lock));
  }

  public async withWriteF<T>(
    ...params: [...([timeout: number] | []), (lock: RWLockWriter) => Promise<T>]
  ): Promise<T> {
    const f = params.pop() as (lock: RWLockWriter) => Promise<T>;
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
      (lock: RWLockWriter) => AsyncGenerator<T, TReturn, TNext>,
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
      (lock: RWLockWriter) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      lock: RWLockWriter,
    ) => AsyncGenerator<T, TReturn, TNext>;
    const timeout = params[0] as number;
    return withG([this.read(timeout)], ([lock]) => g(lock));
  }

  public withWriteG<T, TReturn, TNext>(
    ...params: [
      ...([timeout: number] | []),
      (lock: RWLockWriter) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      lock: RWLockWriter,
    ) => AsyncGenerator<T, TReturn, TNext>;
    const timeout = params[0] as number;
    return withG([this.write(timeout)], ([lock]) => g(lock));
  }
}

export default RWLockWriter;
