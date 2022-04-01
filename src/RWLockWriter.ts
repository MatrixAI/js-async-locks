import type { MutexInterface } from 'async-mutex';
import type { ResourceAcquire } from '@matrixai/resources';
import { performance } from 'perf_hooks';
import { Mutex, withTimeout } from 'async-mutex';
import { withF, withG } from '@matrixai/resources';
import { sleep, yieldMicro } from './utils';
import { ErrorAsyncLocksTimeout } from './errors';

/**
 * Write-preferring read write lock
 */
class RWLockWriter {
  protected readersLock: Mutex = new Mutex();
  protected writersLock: Mutex = new Mutex();
  protected readersRelease: MutexInterface.Releaser;
  protected readerCountBlocked: number = 0;
  protected _readerCount: number = 0;
  protected _writerCount: number = 0;

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
      }
      return [
        async () => {
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
      return [
        async () => {
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

  public get readerCount(): number {
    return this._readerCount + this.readerCountBlocked;
  }

  public get writerCount(): number {
    return this._writerCount;
  }

  public isLocked(): boolean {
    return this.readersLock.isLocked() || this.writersLock.isLocked();
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

  public async withReadF<T>(
    f: (resources: [RWLockWriter]) => Promise<T>,
    timeout?: number,
  ): Promise<T> {
    return withF([this.read(timeout)], f);
  }

  public async withWriteF<T>(
    f: (resources: [RWLockWriter]) => Promise<T>,
    timeout?: number,
  ): Promise<T> {
    return withF([this.write(timeout)], f);
  }

  public withReadG<T, TReturn, TNext>(
    g: (resources: [RWLockWriter]) => AsyncGenerator<T, TReturn, TNext>,
    timeout?: number,
  ): AsyncGenerator<T, TReturn, TNext> {
    return withG([this.read(timeout)], g);
  }

  public withWriteG<T, TReturn, TNext>(
    g: (resources: [RWLockWriter]) => AsyncGenerator<T, TReturn, TNext>,
    timeout?: number,
  ): AsyncGenerator<T, TReturn, TNext> {
    return withG([this.write(timeout)], g);
  }
}

export default RWLockWriter;
