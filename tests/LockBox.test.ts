import { withF, withG } from '@matrixai/resources';
import LockBox from '@/LockBox';
import Lock from '@/Lock';
import RWLockReader from '@/RWLockReader';
import RWLockWriter from '@/RWLockWriter';
import * as utils from '@/utils';
import * as errors from '@/errors';

describe(LockBox.name, () => {
  test('withF', async () => {
    const lockBox = new LockBox();
    const p = withF([lockBox.lock(['1', Lock])], async ([lockBox]) => {
      expect(lockBox.isLocked()).toBe(true);
      expect(lockBox.count).toBe(1);
    });
    expect(lockBox.isLocked()).toBe(true);
    expect(lockBox.count).toBe(1);
    await p;
    expect(lockBox.isLocked()).toBe(false);
    expect(lockBox.count).toBe(0);
  });
  test('withG', async () => {
    const lockBox = new LockBox();
    const g1 = withG(
      [lockBox.lock(['1', RWLockReader, 'write'])],
      async function* ([lockBox]): AsyncGenerator<string, string, void> {
        expect(lockBox.isLocked()).toBe(true);
        expect(lockBox.count).toBe(1);
        yield 'first';
        expect(lockBox.isLocked()).toBe(true);
        expect(lockBox.count).toBe(1);
        yield 'second';
        expect(lockBox.isLocked()).toBe(true);
        expect(lockBox.count).toBe(1);
        return 'last';
      },
    );
    expect(lockBox.isLocked()).toBe(false);
    expect(lockBox.count).toBe(0);
    for await (const _ of g1) {
      // It should be locked during iteration
      expect(lockBox.isLocked()).toBe(true);
      expect(lockBox.count).toBe(1);
    }
    // Note that for await consumes the returned value
    // But does not provide a way to retrieve it
    expect(await g1.next()).toStrictEqual({
      value: undefined,
      done: true,
    });
    expect(lockBox.isLocked()).toBe(false);
    expect(lockBox.count).toBe(0);
    // To actually get the value use while loop or explicit `next()`
    const g2 = withG(
      [lockBox.lock(['1', RWLockReader, 'write'])],
      async function* (): AsyncGenerator<string, string, void> {
        yield 'first';
        yield 'second';
        return 'last';
      },
    );
    // Unlocked before the first next
    expect(lockBox.isLocked()).toBe(false);
    expect(lockBox.count).toBe(0);
    const firstP = g2.next();
    expect(lockBox.isLocked()).toBe(true);
    expect(lockBox.count).toBe(1);
    await firstP;
    expect(lockBox.isLocked()).toBe(true);
    expect(lockBox.count).toBe(1);
    const secondP = g2.next();
    expect(lockBox.isLocked()).toBe(true);
    expect(lockBox.count).toBe(1);
    await secondP;
    expect(lockBox.isLocked()).toBe(true);
    expect(lockBox.count).toBe(1);
    const lastP = g2.next();
    expect(lockBox.isLocked()).toBe(true);
    expect(lockBox.count).toBe(1);
    await lastP;
    // Unlocked after the return
    expect(lockBox.isLocked()).toBe(false);
    expect(lockBox.count).toBe(0);
  });
  test('lock count', async () => {
    const lockBox = new LockBox();
    const p = Promise.all([
      lockBox.withF(['1', Lock], async () => undefined),
      lockBox.withF(['2', RWLockReader, 'write'], async () => undefined),
      lockBox.withF(['3', RWLockReader, 'read'], async () => undefined),
      lockBox.withF(['4', RWLockWriter, 'write'], async () => undefined),
      lockBox.withF(['5', RWLockWriter, 'read'], async () => undefined),
    ]);
    expect(lockBox.count).toBe(5);
    await p;
  });
  test('wait for unlock', async () => {
    const lockBox = new LockBox();
    let value;
    const p1 = withF([lockBox.lock(['1', Lock])], async () => {
      value = 'p1';
      await utils.sleep(100);
    });
    const p2 = lockBox.waitForUnlock(undefined, '1').then(() => {
      value = 'p2';
    });
    await p1;
    await p2;
    expect(value).toBe('p2');
  });
  test('wait for unlock all', async () => {
    const lockBox = new LockBox();
    let value;
    const p1 = withF(
      [lockBox.lock(['1', Lock], [2, RWLockWriter, 'write'])],
      async () => {
        value = 'p1';
        await utils.sleep(100);
      },
    );
    const p2 = lockBox.waitForUnlock().then(() => {
      value = 'p2';
    });
    await p1;
    await p2;
    expect(value).toBe('p2');
  });
  test('unlock when exception is thrown', async () => {
    const lockBox = new LockBox();
    await expect(
      lockBox.withF(
        [1, Lock],
        [2, RWLockWriter, 'write'],
        [3, RWLockReader, 'read'],
        async () => {
          expect(lockBox.isLocked()).toBe(true);
          expect(lockBox.count).toBe(3);
          throw new Error('oh no');
        },
      ),
    ).rejects.toThrow('oh no');
    expect(lockBox.isLocked()).toBe(false);
    expect(lockBox.count).toBe(0);
  });
  test('mutual exclusion', async () => {
    const lockBox = new LockBox();
    let value = 0;
    await Promise.all([
      lockBox.withF(['somelock', Lock], async () => {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
      }),
      lockBox.withF(['somelock', Lock], async () => {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(2);
    value = 0;
    await Promise.all([
      (async () => {
        const g = lockBox.withG(
          ['somelock', Lock],
          async function* (): AsyncGenerator {
            const value_ = value + 1;
            await utils.sleep(100);
            value = value_;
            return 'last';
          },
        );
        for await (const _ of g) {
        }
      })(),
      (async () => {
        const g = lockBox.withG(
          ['somelock', Lock],
          async function* (): AsyncGenerator {
            const value_ = value + 1;
            await utils.sleep(100);
            value = value_;
            return 'last';
          },
        );
        for await (const _ of g) {
        }
      })(),
    ]);
    expect(value).toBe(2);
  });
  test('timeout', async () => {
    const lockBox = new LockBox();
    await withF([lockBox.lock([1, Lock, 0])], async ([lock]) => {
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
      const f = jest.fn();
      await expect(withF([lockBox.lock([1, Lock, 100])], f)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
      expect(lock.isLocked()).toBe(true);
      expect(lock.count).toBe(1);
    });
    expect(lockBox.isLocked()).toBe(false);
    expect(lockBox.count).toBe(0);
    await lockBox.withF([1, Lock, 100], async () => {
      const f = jest.fn();
      await expect(lockBox.withF([1, Lock, 100], f)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
    });
    const g = lockBox.withG([1, Lock, 100], async function* () {
      expect(lockBox.isLocked()).toBe(true);
      expect(lockBox.count).toBe(1);
      const f = jest.fn();
      const g = lockBox.withG([1, Lock, 100], f);
      await expect(g.next()).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
      expect(f).not.toBeCalled();
      expect(lockBox.isLocked()).toBe(true);
      expect(lockBox.count).toBe(1);
    });
    await g.next();
    expect(lockBox.isLocked()).toBe(false);
    expect(lockBox.count).toBe(0);
  });
  test('timeout waiting for unlock', async () => {
    const lockBox = new LockBox();
    await lockBox.waitForUnlock(100);
    await withF([lockBox.lock([1, Lock])], async ([lockBox]) => {
      await lockBox.waitForUnlock(100, 2);
      await expect(lockBox.waitForUnlock(100, 1)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      await expect(lockBox.waitForUnlock(100)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
    });
    await lockBox.waitForUnlock(100);
    const g = withG([lockBox.lock([1, Lock])], async function* ([lockBox]) {
      await lockBox.waitForUnlock(100, 2);
      await expect(lockBox.waitForUnlock(100, 1)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      await expect(lockBox.waitForUnlock(100)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
    });
    await g.next();
    await lockBox.waitForUnlock(100);
  });
  test('multiple types of locks', async () => {
    const lockBox = new LockBox<Lock | RWLockReader | RWLockWriter>();
    await lockBox.withF(
      [1, Lock],
      [2, RWLockReader, 'write'],
      [3, RWLockWriter, 'read'],
      async (lockBox) => {
        expect(lockBox.isLocked(1)).toBe(true);
        expect(lockBox.isLocked(2)).toBe(true);
        expect(lockBox.isLocked(3)).toBe(true);
        const f = jest.fn();
        await expect(
          withF([lockBox.lock([1, Lock, 100], [2, Lock, 100])], f),
        ).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
        expect(f).not.toBeCalled();
      },
    );
  });
  test('cannot use different lock type on the same active key', async () => {
    const lockBox = new LockBox<Lock | RWLockReader | RWLockWriter>();
    await lockBox.withF([3, Lock], async (lockBox) => {
      const f = jest.fn();
      await expect(
        lockBox.withF([3, RWLockReader, 'write'], f),
      ).rejects.toThrow(errors.ErrorAsyncLocksLockBoxConflict);
      expect(f).not.toBeCalled();
    });
    await lockBox.withF([3, RWLockReader, 'write'], async (lockBox) => {
      const f = jest.fn();
      await expect(lockBox.withF([3, Lock], f)).rejects.toThrow(
        errors.ErrorAsyncLocksLockBoxConflict,
      );
      expect(f).not.toBeCalled();
    });
  });
  test('prevent deadlocks with lock hierarchy via sorted lock keys', async () => {
    const lockBox = new LockBox<Lock | RWLockReader | RWLockWriter>();
    let value = 0;
    await Promise.all([
      lockBox.withF([1, Lock], [2, Lock], [3, Lock], [4, Lock], async () => {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
      }),
      lockBox.withF([4, Lock], [3, Lock], [2, Lock], [1, Lock], async () => {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(2);
    value = 0;
    const g1 = lockBox.withG(
      ['1', Lock],
      ['2', Lock],
      async function* (): AsyncGenerator {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
        return 'last';
      },
    );
    const g2 = lockBox.withG(
      ['2', Lock],
      ['1', Lock],
      async function* (): AsyncGenerator {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
        return 'last';
      },
    );
    await Promise.all([
      (async () => {
        for await (const _ of g1) {
        }
      })(),
      (async () => {
        for await (const _ of g2) {
        }
      })(),
    ]);
    expect(value).toBe(2);
  });
});
