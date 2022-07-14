import type { ResourceRelease } from '@matrixai/resources';
import Lock from './Lock';
import { ErrorAsyncLocksBarrierCount } from './errors';

class Barrier {
  protected lock: Lock;
  protected count: number;
  protected release: ResourceRelease;

  public static async createBarrier(count: number) {
    const lock = new Lock();
    const [release] = await lock.lock()();
    return new this(count, lock, release);
  }

  protected constructor(count: number, lock: Lock, release: ResourceRelease) {
    if (count < 0) {
      throw new ErrorAsyncLocksBarrierCount();
    }
    this.lock = lock;
    this.release = release;
    this.count = count;
  }

  public async wait(timeout?: number): Promise<void> {
    if (!this.lock.isLocked()) {
      return;
    }
    this.count = Math.max(this.count - 1, 0);
    if (this.count === 0) {
      await this.release();
    } else {
      await this.lock.waitForUnlock(timeout);
    }
  }
}

export default Barrier;
