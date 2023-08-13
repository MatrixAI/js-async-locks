import { withF, withG } from '@matrixai/resources';
import * as testsUtils from './utils.js';
import Lock from '#Lock.js';
import * as errors from '#errors.js';

describe(Lock.name, () => {
  test('withF', async () => {
    const lock = new Lock();
    const p = withF([lock.lock()], async ([lock]) => {
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
    });
    expect(lock.isLocked()).toBe(true);
    expect(lock.count).toBe(1);
    await p;
    expect(lock.isLocked()).toBe(false);
    expect(lock.count).toBe(0);
  });
  test('withG', async () => {
    const lock = new Lock();
    const g1 = withG([lock.lock()], async function* ([lock]): AsyncGenerator<
      string,
      string,
      void
    > {
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
      yield 'first';
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
      yield 'second';
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
      return 'last';
    });
    expect(lock.isLocked()).toBe(false);
    expect(lock.count).toBe(0);
    for await (const _ of g1) {
      // It should be locked during iteration
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
    }
    // Note that for await consumes the returned value
    // But does not provide a way to retrieve it
    expect(await g1.next()).toStrictEqual({
      value: undefined,
      done: true,
    });
    expect(lock.isLocked()).toBe(false);
    expect(lock.count).toBe(0);
    // To actually get the value use while loop or explicit `next()`
    const g2 = withG([lock.lock()], async function* (): AsyncGenerator<
      string,
      string,
      void
    > {
      yield 'first';
      yield 'second';
      return 'last';
    });
    // Unlocked before the first next
    expect(lock.isLocked()).toBe(false);
    expect(lock.count).toBe(0);
    const firstP = g2.next();
    expect(lock.isLocked()).toBe(true);
    expect(lock.count).toBe(1);
    await firstP;
    expect(lock.isLocked()).toBe(true);
    expect(lock.count).toBe(1);
    const secondP = g2.next();
    expect(lock.isLocked()).toBe(true);
    expect(lock.count).toBe(1);
    await secondP;
    expect(lock.isLocked()).toBe(true);
    expect(lock.count).toBe(1);
    const lastP = g2.next();
    expect(lock.isLocked()).toBe(true);
    expect(lock.count).toBe(1);
    await lastP;
    // Unlocked after the return
    expect(lock.isLocked()).toBe(false);
    expect(lock.count).toBe(0);
  });
  test('lock count', async () => {
    const lock = new Lock();
    const p = Promise.all([
      lock.withF(async () => undefined),
      lock.withF(async () => undefined),
      lock.withF(async () => undefined),
      lock.withF(async () => undefined),
    ]);
    expect(lock.count).toBe(4);
    await p;
  });
  test('wait for unlock', async () => {
    const lock = new Lock();
    let value;
    const p1 = withF([lock.lock()], async () => {
      value = 'p1';
      await testsUtils.sleep(100);
    });
    const p2 = lock.waitForUnlock().then(() => {
      value = 'p2';
    });
    await p1;
    await p2;
    expect(value).toBe('p2');
  });
  test('unlock when exception is thrown', async () => {
    const lock = new Lock();
    await expect(
      lock.withF(async () => {
        expect(lock.isLocked()).toBe(true);
        expect(lock.count).toBe(1);
        throw new Error('oh no');
      }),
    ).rejects.toThrow('oh no');
    expect(lock.isLocked()).toBe(false);
    expect(lock.count).toBe(0);
  });
  test('mutual exclusion', async () => {
    const lock = new Lock();
    let value = 0;
    await Promise.all([
      lock.withF(async () => {
        const value_ = value + 1;
        await testsUtils.sleep(100);
        value = value_;
      }),
      lock.withF(async () => {
        const value_ = value + 1;
        await testsUtils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(2);
    value = 0;
    await Promise.all([
      (async () => {
        const g = lock.withG(async function* (): AsyncGenerator {
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
        const g = lock.withG(async function* (): AsyncGenerator {
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
    const lock = new Lock();
    await withF([lock.lock({ timer: 0 })], async ([lock]) => {
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
      const f = jest.fn();
      await expect(withF([lock.lock({ timer: 100 })], f)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
    });
    expect(lock.isLocked()).toBe(false);
    expect(lock.count).toBe(0);
    await lock.withF({ timer: 100 }, async () => {
      const f = jest.fn();
      await expect(lock.withF({ timer: 100 }, f)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
    });
    const g = lock.withG({ timer: 100 }, async function* () {
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
      const f = jest.fn();
      const g = lock.withG({ timer: 100 }, f);
      await expect(g.next()).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
      expect(f).not.toBeCalled();
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
    });
    await g.next();
    expect(lock.isLocked()).toBe(false);
    expect(lock.count).toBe(0);
  });
  test('timeout waiting for unlock', async () => {
    const lock = new Lock();
    await lock.waitForUnlock({ timer: 100 });
    await withF([lock.lock()], async ([lock]) => {
      await expect(lock.waitForUnlock({ timer: 100 })).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
    });
    await lock.waitForUnlock({ timer: 100 });
    const g = withG([lock.lock()], async function* ([lock]) {
      await expect(lock.waitForUnlock({ timer: 100 })).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
    });
    await g.next();
    await lock.waitForUnlock({ timer: 100 });
  });
  test('release is idempotent', async () => {
    const lock = new Lock();
    let lockAcquire = lock.lock();
    let [lockRelease] = await lockAcquire();
    await lockRelease();
    await lockRelease();
    expect(lock.count).toBe(0);
    lockAcquire = lock.lock();
    [lockRelease] = await lockAcquire();
    await lockRelease();
    await lockRelease();
    expect(lock.count).toBe(0);
  });
  test('promise cancellation', async () => {
    const lock = new Lock();
    const [release] = await lock.lock()();
    expect(lock.count).toBe(1);
    const lockAcquire = lock.lock();
    const lockAcquireP = lockAcquire();
    expect(lock.count).toBe(2);
    lockAcquireP.cancel(new Error('reason'));
    await expect(lockAcquireP).rejects.toThrow('reason');
    await release();
    expect(lock.count).toBe(0);
  });
  test('abort lock', async () => {
    const lock = new Lock();
    const [release] = await lock.lock()();
    const abc = new AbortController();
    // Abort after 10ms
    setTimeout(() => {
      abc.abort();
    }, 10);
    // Wait for 100ms, but we will expect abortion
    await expect(lock.lock({ signal: abc.signal, timer: 100 })()).rejects.toBe(
      undefined,
    );
    await release();
    expect(lock.count).toBe(0);
    expect(lock.isLocked()).toBeFalse();
  });
});
