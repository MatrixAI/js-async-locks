import { withF, withG } from '@matrixai/resources';
import Lock from '@/Lock';
import * as testUtils from './utils';

describe(Lock.name, () => {
  test('withF', async () => {
    const lock = new Lock();
    const p = withF([lock.acquire], async ([lock]) => {
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
    const g1 = withG([lock.acquire], async function* ([lock]): AsyncGenerator<
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
    const g2 = withG([lock.acquire], async function* (): AsyncGenerator<
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
    const p1 = withF([lock.acquire], async () => {
      value = 'p1';
      await testUtils.sleep(100);
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
        await testUtils.sleep(100);
        value = value_;
      }),
      lock.withF(async () => {
        const value_ = value + 1;
        await testUtils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(2);
    value = 0;
    await Promise.all([
      (async () => {
        const g = lock.withG(async function* (): AsyncGenerator {
          const value_ = value + 1;
          await testUtils.sleep(100);
          value = value_;
          return 'last';
        });
        for await (const _ of g) {
        }
      })(),
      (async () => {
        const g = lock.withG(async function* (): AsyncGenerator {
          const value_ = value + 1;
          await testUtils.sleep(100);
          value = value_;
          return 'last';
        });
        for await (const _ of g) {
        }
      })(),
    ]);
    expect(value).toBe(2);
  });
});
