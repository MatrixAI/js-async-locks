import type { ResourceRelease } from '@matrixai/resources';
import type { ContextTimedInput } from './types';
import { PromiseCancellable } from '@matrixai/async-cancellable';
import Lock from './Lock';

class Barrier {
  protected lock: Lock;
  protected _count: number;
  protected release: ResourceRelease;

  public static async createBarrier(count: number) {
    const lock = new Lock();
    const [release] = await lock.lock()();
    return new this(count, lock, release);
  }

  protected constructor(count: number, lock: Lock, release: ResourceRelease) {
    if (count < 0) {
      throw new RangeError(
        'Barrier must be constructed with `count` >= than 0',
      );
    }
    this.lock = lock;
    this.release = release;
    this._count = count;
  }

  public get count(): number {
    return this._count;
  }

  public async destroy() {
    await this.release();
  }

  public wait(ctx?: Partial<ContextTimedInput>): PromiseCancellable<void> {
    if (!this.lock.isLocked()) {
      return PromiseCancellable.resolve();
    }
    this._count = Math.max(this._count - 1, 0);
    if (this._count === 0) {
      return PromiseCancellable.from(this.release());
    } else {
      return this.lock.waitForUnlock(ctx);
    }
  }
}

export default Barrier;
