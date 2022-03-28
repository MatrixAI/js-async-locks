import type { MutexInterface } from 'async-mutex';
import type { ResourceAcquire } from '@matrixai/resources';
import { Mutex } from 'async-mutex';
import { withF, withG } from '@matrixai/resources';

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

  public acquireRead: ResourceAcquire<RWLockWriter> = async () => {
    if (this._writerCount > 0) {
      ++this.readerCountBlocked;
      await this.writersLock.waitForUnlock();
      --this.readerCountBlocked;
    }
    const readerCount = ++this._readerCount;
    // The first reader locks
    if (readerCount === 1) {
      this.readersRelease = await this.readersLock.acquire();
    }
    return [
      async () => {
        const readerCount = --this._readerCount;
        // The last reader unlocks
        if (readerCount === 0) {
          this.readersRelease();
        }
      },
      this,
    ];
  };

  public acquireWrite: ResourceAcquire<RWLockWriter> = async () => {
    ++this._writerCount;
    const writersRelease = await this.writersLock.acquire();
    this.readersRelease = await this.readersLock.acquire();
    return [
      async () => {
        this.readersRelease();
        writersRelease();
        --this._writerCount;
      },
      this,
    ];
  };

  public get readerCount(): number {
    return this._readerCount + this.readerCountBlocked;
  }

  public get writerCount(): number {
    return this._writerCount;
  }

  public isLocked(): boolean {
    return this.readersLock.isLocked() || this.writersLock.isLocked();
  }

  public async waitForUnlock(): Promise<void> {
    await Promise.all([
      this.readersLock.waitForUnlock(),
      this.writersLock.waitForUnlock(),
    ]);
    return;
  }

  public async withReadF<T>(
    f: (resources: [RWLockWriter]) => Promise<T>,
  ): Promise<T> {
    return withF([this.acquireRead], f);
  }

  public async withWriteF<T>(
    f: (resources: [RWLockWriter]) => Promise<T>,
  ): Promise<T> {
    return withF([this.acquireWrite], f);
  }

  public withReadG<T, TReturn, TNext>(
    g: (resources: [RWLockWriter]) => AsyncGenerator<T, TReturn, TNext>,
  ): AsyncGenerator<T, TReturn, TNext> {
    return withG([this.acquireRead], g);
  }

  public withWriteG<T, TReturn, TNext>(
    g: (resources: [RWLockWriter]) => AsyncGenerator<T, TReturn, TNext>,
  ): AsyncGenerator<T, TReturn, TNext> {
    return withG([this.acquireWrite], g);
  }
}

export default RWLockWriter;
