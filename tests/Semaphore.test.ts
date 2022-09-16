import type { ResourceRelease } from '@matrixai/resources';
import { withF, withG } from '@matrixai/resources';
import Semaphore from '@/Semaphore';
import * as utils from '@/utils';
import * as errors from '@/errors';

describe(Semaphore.name, () => {
  test('semaphore only takes limit >= 1', async () => {
    expect(() => new Semaphore(-1)).toThrow(
      errors.ErrorAsyncLocksSemaphoreLimit,
    );
    expect(() => new Semaphore(0)).toThrow(
      errors.ErrorAsyncLocksSemaphoreLimit,
    );
  });
  test('semaphore blocks when limit is reached', async () => {
    const semaphore = new Semaphore(2);
    let called1 = false;
    let called2 = false;
    let called3 = false;
    let calledCount = 0;
    let t1Release;
    let t2Release;
    let t3Release;
    const t1 = async () => {
      [t1Release] = await semaphore.lock()();
      called1 = true;
      calledCount++;
    };
    const t2 = async () => {
      [t2Release] = await semaphore.lock()();
      called2 = true;
      calledCount++;
    };
    const t3 = async () => {
      [t3Release] = await semaphore.lock()();
      called3 = true;
      calledCount++;
    };
    const p1 = t1();
    const p2 = t2();
    const p3 = t3();
    await utils.sleep(0);
    expect(calledCount).toBe(2);
    const [, release] = [
      [called1, t1Release],
      [called2, t2Release],
      [called3, t3Release],
    ].find(([called]) => called === true) as [boolean, ResourceRelease];
    await release();
    await utils.sleep(0);
    expect(calledCount).toBe(3);
    const results = await Promise.allSettled([p1, p2, p3]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  });
  test('semaphore wait with timeout', async () => {
    const semaphore = new Semaphore(1);
    const [release] = await semaphore.lock()();
    await expect(semaphore.lock(10)()).rejects.toThrow(
      errors.ErrorAsyncLocksTimeout,
    );
    await release();
    await expect(semaphore.lock(10)()).resolves.toBeDefined();
  });
  test('withF', async () => {
    const semaphore = new Semaphore(1);
    const p = withF([semaphore.lock()], async ([lock]) => {
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
    });
    expect(semaphore.isLocked()).toBe(true);
    expect(semaphore.count).toBe(1);
    await p;
    expect(semaphore.isLocked()).toBe(false);
    expect(semaphore.count).toBe(0);
  });
  test('withG', async () => {
    const semaphore = new Semaphore(1);
    const g1 = withG(
      [semaphore.lock()],
      async function* ([lock]): AsyncGenerator<string, string, void> {
        expect(lock.isLocked()).toBe(true);
        expect(lock.count).toBe(1);
        yield 'first';
        expect(lock.isLocked()).toBe(true);
        expect(lock.count).toBe(1);
        yield 'second';
        expect(lock.isLocked()).toBe(true);
        expect(lock.count).toBe(1);
        return 'last';
      },
    );
    expect(semaphore.isLocked()).toBe(false);
    expect(semaphore.count).toBe(0);
    for await (const _ of g1) {
      // It should be locked during iteration
      expect(semaphore.isLocked()).toBe(true);
      expect(semaphore.count).toBe(1);
    }
    // Note that for await consumes the returned value
    // But does not provide a way to retrieve it
    expect(await g1.next()).toStrictEqual({
      value: undefined,
      done: true,
    });
    expect(semaphore.isLocked()).toBe(false);
    expect(semaphore.count).toBe(0);
    // To actually get the value use while loop or explicit `next()`
    const g2 = withG([semaphore.lock()], async function* (): AsyncGenerator<
      string,
      string,
      void
    > {
      yield 'first';
      yield 'second';
      return 'last';
    });
    // Unlocked before the first next
    expect(semaphore.isLocked()).toBe(false);
    expect(semaphore.count).toBe(0);
    const firstP = g2.next();
    expect(semaphore.isLocked()).toBe(true);
    expect(semaphore.count).toBe(1);
    await firstP;
    expect(semaphore.isLocked()).toBe(true);
    expect(semaphore.count).toBe(1);
    const secondP = g2.next();
    expect(semaphore.isLocked()).toBe(true);
    expect(semaphore.count).toBe(1);
    await secondP;
    expect(semaphore.isLocked()).toBe(true);
    expect(semaphore.count).toBe(1);
    const lastP = g2.next();
    expect(semaphore.isLocked()).toBe(true);
    expect(semaphore.count).toBe(1);
    await lastP;
    // Unlocked after the return
    expect(semaphore.isLocked()).toBe(false);
    expect(semaphore.count).toBe(0);
  });
  test('lock count', async () => {
    const semaphore = new Semaphore(1);
    const p = Promise.all([
      semaphore.withF(async () => undefined),
      semaphore.withF(async () => undefined),
      semaphore.withF(async () => undefined),
      semaphore.withF(async () => undefined),
    ]);
    expect(semaphore.count).toBe(4);
    await p;
  });
  test('wait for unlock', async () => {
    const semaphore = new Semaphore(1);
    let value;
    const p1 = withF([semaphore.lock()], async () => {
      value = 'p1';
      await utils.sleep(100);
    });
    const p2 = semaphore.waitForUnlock().then(() => {
      value = 'p2';
    });
    await p1;
    await p2;
    expect(value).toBe('p2');
  });
  test('unlock when exception is thrown', async () => {
    const semaphore = new Semaphore(1);
    await expect(
      semaphore.withF(async () => {
        expect(semaphore.isLocked()).toBe(true);
        expect(semaphore.count).toBe(1);
        throw new Error('oh no');
      }),
    ).rejects.toThrow('oh no');
    expect(semaphore.isLocked()).toBe(false);
    expect(semaphore.count).toBe(0);
  });
  test('mutual exclusion', async () => {
    const semaphore = new Semaphore(1);
    let value = 0;
    await Promise.all([
      semaphore.withF(async () => {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
      }),
      semaphore.withF(async () => {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(2);
    value = 0;
    await Promise.all([
      (async () => {
        const g = semaphore.withG(async function* (): AsyncGenerator {
          const value_ = value + 1;
          await utils.sleep(100);
          value = value_;
          return 'last';
        });
        for await (const _ of g) {
          // Noop
        }
      })(),
      (async () => {
        const g = semaphore.withG(async function* (): AsyncGenerator {
          const value_ = value + 1;
          await utils.sleep(100);
          value = value_;
          return 'last';
        });
        for await (const _ of g) {
          // Noop
        }
      })(),
    ]);
    expect(value).toBe(2);
  });
  test('timeout', async () => {
    const semaphore = new Semaphore(1);
    await withF([semaphore.lock(0)], async ([lock]) => {
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
      const f = jest.fn();
      await expect(withF([lock.lock(100)], f)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
    });
    expect(semaphore.isLocked()).toBe(false);
    expect(semaphore.count).toBe(0);
    await semaphore.withF(100, async () => {
      const f = jest.fn();
      await expect(semaphore.withF(100, f)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
    });
    const g = semaphore.withG(100, async function* () {
      expect(semaphore.isLocked()).toBe(true);
      expect(semaphore.count).toBe(1);
      const f = jest.fn();
      const g = semaphore.withG(100, f);
      await expect(g.next()).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
      expect(f).not.toBeCalled();
      expect(semaphore.isLocked()).toBe(true);
      expect(semaphore.count).toBe(1);
    });
    await g.next();
    expect(semaphore.isLocked()).toBe(false);
    expect(semaphore.count).toBe(0);
  });
  test('timeout waiting for unlock', async () => {
    const semaphore = new Semaphore(1);
    await semaphore.waitForUnlock(100);
    await withF([semaphore.lock()], async ([lock]) => {
      await expect(lock.waitForUnlock(100)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
    });
    await semaphore.waitForUnlock(100);
    const g = withG([semaphore.lock()], async function* ([lock]) {
      await expect(lock.waitForUnlock(100)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
    });
    await g.next();
    await semaphore.waitForUnlock(100);
  });
  test('release is idempotent', async () => {
    const semaphore = new Semaphore(1);
    let lockAcquire = semaphore.lock();
    let [lockRelease] = await lockAcquire();
    await lockRelease();
    await lockRelease();
    expect(semaphore.count).toBe(0);
    lockAcquire = semaphore.lock();
    [lockRelease] = await lockAcquire();
    await lockRelease();
    await lockRelease();
    expect(semaphore.count).toBe(0);
  });
});
