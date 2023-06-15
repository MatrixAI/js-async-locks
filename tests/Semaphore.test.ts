import type { ResourceRelease } from '@matrixai/resources';
import { withF, withG } from '@matrixai/resources';
import Semaphore from '@/Semaphore';
import * as errors from '@/errors';
import * as testsUtils from './utils';

describe(Semaphore.name, () => {
  test('semaphore only takes limit >= 1', async () => {
    expect(() => new Semaphore(-1)).toThrow(RangeError);
    expect(() => new Semaphore(0)).toThrow(RangeError);
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
    await testsUtils.sleep(0);
    expect(calledCount).toBe(2);
    const [, release] = [
      [called1, t1Release],
      [called2, t2Release],
      [called3, t3Release],
    ].find(([called]) => called === true) as [boolean, ResourceRelease];
    await release();
    await testsUtils.sleep(0);
    expect(calledCount).toBe(3);
    const results = await Promise.allSettled([p1, p2, p3]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  });
  test('semaphore wait with timeout', async () => {
    const semaphore = new Semaphore(1);
    const [release] = await semaphore.lock()();
    await expect(semaphore.lock(undefined, { timer: 10 })()).rejects.toThrow(
      errors.ErrorAsyncLocksTimeout,
    );
    await release();
    await expect(
      semaphore.lock(undefined, { timer: 10 })(),
    ).resolves.toBeDefined();
  });
  test('semaphore blocks lockers in FIFO manner with unprioritized weights', async () => {
    const semaphore = new Semaphore(3);
    const [release] = await semaphore.lock(1)();
    await expect(
      Promise.allSettled([
        semaphore.lock(3, { timer: 10 })(),
        semaphore.lock(2, { timer: 10 })(),
      ]),
    ).resolves.toEqual([
      { status: 'rejected', reason: new errors.ErrorAsyncLocksTimeout() },
      { status: 'rejected', reason: new errors.ErrorAsyncLocksTimeout() },
    ]);
    await release();
    expect(semaphore.count).toBe(0);
    expect(semaphore.isLocked()).toBeFalse();
  });
  test('semaphore does not block lockers in FIFO manner with prioritized weights', async () => {
    // This prioritizes small weights which increases concurrency at the cost
    // of fairness because small locks may starve the larger lock
    const semaphore = new Semaphore(3, true);
    const [release] = await semaphore.lock(1)();
    const p1 = semaphore.lock(3, { timer: 10 })();
    const p2 = semaphore.lock(2, { timer: 10 })();
    const results = Promise.allSettled([p1, p2]);
    await expect(results).resolves.toEqual([
      { status: 'rejected', reason: new errors.ErrorAsyncLocksTimeout() },
      { status: 'fulfilled', value: expect.any(Array) },
    ]);
    await release();
    await (await p2)[0]();
    expect(semaphore.count).toBe(0);
    expect(semaphore.isLocked()).toBeFalse();
  });
  test('semaphore blocks waiters in FIFO manner with unprioritized weights', async () => {
    const semaphore = new Semaphore(3);
    const [release] = await semaphore.lock(1)();
    let called1 = false;
    let called2 = false;
    const p1 = (async () => {
      await semaphore.waitForUnlock(3);
      called1 = true;
    })();
    const p2 = (async () => {
      await semaphore.waitForUnlock(2);
      called2 = true;
    })();
    await testsUtils.sleep(1);
    expect(called1).toBeFalse();
    expect(called2).toBeFalse();
    await release();
    await Promise.all([p1, p2]);
    expect(called1).toBeTrue();
    expect(called2).toBeTrue();
    expect(semaphore.count).toBe(0);
    expect(semaphore.isLocked()).toBeFalse();
  });
  test('semaphore does not block waiters in FIFO manner with prioiritized weights', async () => {
    const semaphore = new Semaphore(3, true);
    const [release] = await semaphore.lock(1)();
    let called1 = false;
    let called2 = false;
    const p1 = (async () => {
      await semaphore.waitForUnlock(3);
      called1 = true;
    })();
    const p2 = (async () => {
      await semaphore.waitForUnlock(2);
      called2 = true;
    })();
    await testsUtils.sleep(1);
    expect(called1).toBeFalse();
    expect(called2).toBeTrue();
    await release();
    await Promise.all([p1, p2]);
    expect(called1).toBeTrue();
    expect(semaphore.count).toBe(0);
    expect(semaphore.isLocked()).toBeFalse();
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
      await testsUtils.sleep(100);
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
        await testsUtils.sleep(100);
        value = value_;
      }),
      semaphore.withF(async () => {
        const value_ = value + 1;
        await testsUtils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(2);
    value = 0;
    await Promise.all([
      (async () => {
        const g = semaphore.withG(async function* (): AsyncGenerator {
          const value_ = value + 1;
          await testsUtils.sleep(100);
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
          await testsUtils.sleep(100);
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
    await withF([semaphore.lock(undefined, { timer: 0 })], async ([lock]) => {
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
      const f = jest.fn();
      await expect(
        withF([lock.lock(undefined, { timer: 100 })], f),
      ).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
      expect(f).not.toBeCalled();
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
    });
    expect(semaphore.isLocked()).toBe(false);
    expect(semaphore.count).toBe(0);
    await semaphore.withF({ timer: 100 }, async () => {
      const f = jest.fn();
      await expect(semaphore.withF({ timer: 100 }, f)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
    });
    const g = semaphore.withG({ timer: 100 }, async function* () {
      expect(semaphore.isLocked()).toBe(true);
      expect(semaphore.count).toBe(1);
      const f = jest.fn();
      const g = semaphore.withG({ timer: 100 }, f);
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
    await semaphore.waitForUnlock(undefined, { timer: 100 });
    await withF([semaphore.lock()], async ([lock]) => {
      await expect(
        lock.waitForUnlock(undefined, { timer: 100 }),
      ).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
    });
    await semaphore.waitForUnlock(undefined, { timer: 100 });
    const g = withG([semaphore.lock()], async function* ([lock]) {
      await expect(
        lock.waitForUnlock(undefined, { timer: 100 }),
      ).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
    });
    await g.next();
    await semaphore.waitForUnlock(undefined, { timer: 100 });
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
  test('promise cancellation', async () => {
    const semaphore = new Semaphore(1);
    const [release] = await semaphore.lock()();
    expect(semaphore.count).toBe(1);
    const lockAcquire = semaphore.lock();
    const lockAcquireP = lockAcquire();
    expect(semaphore.count).toBe(2);
    lockAcquireP.cancel(new Error('reason'));
    await expect(lockAcquireP).rejects.toThrow('reason');
    await release();
    expect(semaphore.count).toBe(0);
  });
  test('abort lock', async () => {
    const semaphore = new Semaphore(3);
    const [release] = await semaphore.lock(1)();
    const abc = new AbortController();
    // Abort after 10ms
    setTimeout(() => {
      abc.abort();
    }, 10);
    // Wait for 100ms, but we will expect abortion
    await expect(
      semaphore.lock(3, { signal: abc.signal, timer: 100 })(),
    ).rejects.toBe(undefined);
    await release();
    expect(semaphore.count).toBe(0);
    expect(semaphore.isLocked()).toBeFalse();
  });
});
