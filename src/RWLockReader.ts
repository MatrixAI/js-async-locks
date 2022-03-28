import type { MutexInterface } from 'async-mutex';
import type { ResourceAcquire } from '@matrixai/resources';
import { Mutex } from 'async-mutex';
import { withF, withG } from '@matrixai/resources';

/**
 * Read-preferring read write lock
 */
class RWLockReader {
  protected _readerCount: number = 0;
  protected _writerCount: number = 0;
  protected lock: Mutex = new Mutex();
  protected release: MutexInterface.Releaser;

  public acquireRead: ResourceAcquire<RWLockReader> = async () => {
    const readerCount = ++this._readerCount;
    // The first reader locks
    if (readerCount === 1) {
      this.release = await this.lock.acquire();
    }
    return [
      async () => {
        const readerCount = --this._readerCount;
        // The last reader unlocks
        if (readerCount === 0) {
          this.release();
        }
      },
      this,
    ];
  };

  public acquireWrite: ResourceAcquire<RWLockReader> = async () => {
    ++this._writerCount;
    this.release = await this.lock.acquire();
    return [
      async () => {
        --this._writerCount;
        this.release();
      },
      this,
    ];
  };

  public get readerCount(): number {
    return this._readerCount;
  }

  public get writerCount(): number {
    return this._writerCount;
  }

  public isLocked(): boolean {
    return this.lock.isLocked();
  }

  public async waitForUnlock(): Promise<void> {
    return this.lock.waitForUnlock();
  }

  public async withReadF<T>(
    f: (resources: [RWLockReader]) => Promise<T>,
  ): Promise<T> {
    return withF([this.acquireRead], f);
  }

  public async withWriteF<T>(
    f: (resources: [RWLockReader]) => Promise<T>,
  ): Promise<T> {
    return withF([this.acquireWrite], f);
  }

  public withReadG<T, TReturn, TNext>(
    g: (resources: [RWLockReader]) => AsyncGenerator<T, TReturn, TNext>,
  ): AsyncGenerator<T, TReturn, TNext> {
    return withG([this.acquireRead], g);
  }

  public withWriteG<T, TReturn, TNext>(
    g: (resources: [RWLockReader]) => AsyncGenerator<T, TReturn, TNext>,
  ): AsyncGenerator<T, TReturn, TNext> {
    return withG([this.acquireWrite], g);
  }
}

export default RWLockReader;
