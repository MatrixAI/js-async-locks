import type { MutexInterface } from 'async-mutex';
import type { ResourceAcquire } from '@matrixai/resources';
import { Mutex } from 'async-mutex';
import { withF, withG } from '@matrixai/resources';

class Lock {
  protected lock: Mutex = new Mutex();
  protected release: MutexInterface.Releaser;
  protected _count: number = 0;

  public acquire: ResourceAcquire<Lock> = async () => {
    ++this._count;
    this.release = await this.lock.acquire();
    return [
      async () => {
        --this._count;
        this.release();
      },
      this,
    ];
  };

  public get count(): number {
    return this._count;
  }

  public isLocked(): boolean {
    return this.lock.isLocked();
  }

  public async waitForUnlock(): Promise<void> {
    return this.lock.waitForUnlock();
  }

  public async withF<T>(f: (resources: [Lock]) => Promise<T>): Promise<T> {
    return withF([this.acquire], f);
  }

  public withG<T, TReturn, TNext>(
    g: (resources: [Lock]) => AsyncGenerator<T, TReturn, TNext>,
  ): AsyncGenerator<T, TReturn, TNext> {
    return withG([this.acquire], g);
  }
}

export default Lock;
