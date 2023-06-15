import type { RWLockRequest } from '@/types';
import { withF, withG } from '@matrixai/resources';
import RWLockWriter from '@/RWLockWriter';
import LockBox from '@/LockBox';
import Monitor from '@/Monitor';
import * as errors from '@/errors';
import * as testsUtils from './utils';

describe(Monitor.name, () => {
  test('monitors can lock and unlock', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor = new Monitor(lockBox, RWLockWriter);
    await monitor.lock('foo')();
    await monitor.unlock('foo');
    expect(monitor.count).toBe(0);
    await monitor.lock('foo', 'bar')();
    await monitor.unlock('bar');
    expect(monitor.count).toBe(1);
    expect(monitor.locks.has('foo')).toBeTrue();
    expect(monitor.isLocked('foo')).toBeTrue();
    await monitor.unlockAll();
    await monitor.lock('foo', 'bar')();
    await monitor.unlock('bar', 'foo');
    expect(monitor.count).toBe(0);
    await monitor.lock('foo', 'bar')();
    await monitor.unlock('foo', 'bar');
    expect(monitor.count).toBe(0);
    // Duplicates are eliminated
    await monitor.lock('foo', 'foo')();
    expect(monitor.count).toBe(1);
    await monitor.unlock('foo', 'bar');
    expect(monitor.count).toBe(0);
  });
  test('monitors share the lockbox', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    await monitor1.lock('a')();
    expect(lockBox.isLocked('a'));
    expect(monitor1.isLocked('a')).toBeTrue();
    expect(monitor2.isLocked('a')).toBeFalse();
    await expect(monitor2.lock('a', { timer: 50 })()).rejects.toThrow(
      errors.ErrorAsyncLocksTimeout,
    );
    await monitor1.unlockAll();
    await monitor2.unlockAll();
  });
  test('monitor can lock read and write', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    await monitor1.lock(['foo', 'read'])();
    await monitor1.lock(['bar', 'write'])();
    await expect(monitor1.lock(['foo', 'write'])()).rejects.toThrow(
      errors.ErrorAsyncLocksMonitorLockType,
    );
    await expect(monitor1.lock(['bar', 'read'])()).rejects.toThrow(
      errors.ErrorAsyncLocksMonitorLockType,
    );
    await monitor2.lock(['foo', 'read'])();
    await expect(monitor2.lock(['bar', 'write', { timer: 0 }])).rejects.toThrow(
      errors.ErrorAsyncLocksTimeout,
    );
    expect(monitor1.locks.size).toBe(2);
    expect(monitor1.locks.has('foo')).toBeTrue();
    expect(monitor1.locks.get('foo')!.type).toBe('read');
    expect(monitor2.locks.size).toBe(1);
    expect(monitor2.locks.has('foo')).toBeTrue();
    expect(monitor2.locks.get('foo')!.type).toBe('read');
    await monitor2.unlockAll();
    expect(monitor1.locks.size).toBe(2);
    await monitor1.unlock('bar');
    await monitor2.lock(['foo', 'read'])();
    await monitor2.lock(['bar', 'write'])();
    expect(monitor1.locks.size).toBe(1);
    expect(monitor1.locks.has('foo')).toBeTrue();
    expect(monitor1.locks.get('foo')!.type).toBe('read');
    expect(monitor2.locks.size).toBe(2);
    expect(monitor2.locks.has('foo')).toBeTrue();
    expect(monitor2.locks.get('foo')!.type).toBe('read');
    expect(monitor2.locks.has('bar')).toBeTrue();
    expect(monitor2.locks.get('bar')!.type).toBe('write');
  });
  test('monitor locks are unlocked in reverse order', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    const monitor3 = new Monitor(lockBox, RWLockWriter);
    await monitor1.lock('1')();
    await monitor1.lock('2')();
    const order: Array<string> = [];
    const p1 = monitor2
      .lock('1')()
      .then(() => {
        order.push('1');
      });
    const p2 = monitor3
      .lock('2')()
      .then(() => {
        order.push('2');
      });
    await monitor1.unlockAll();
    await Promise.all([p2, p1]);
    expect(order).toStrictEqual(['2', '1']);
    await monitor2.unlockAll();
    await monitor3.unlockAll();
  });
  test('monitors are re-entrant', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor = new Monitor(lockBox, RWLockWriter);
    await monitor.lock('a')();
    await monitor.lock('a')();
    await monitor.lock('a')();
    await monitor.lock('b')();
    await monitor.lock('b')();
    await monitor.lock('a', 'b')();
    await monitor.unlockAll();
  });
  test('monitor locks are are isolated', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    await monitor1.lock('key1', 'key2')();
    expect(monitor1.locks.size).toBe(2);
    // This is a noop, because `tran1` owns `key1` and `key2`
    await monitor2.unlock('key1', 'key2');
    // This fails because `key1` is still locked by `tran1`
    await expect(
      monitor2.lock(['key1', 'write'], { timer: 0 }),
    ).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
    await monitor1.unlock('key1');
    expect(monitor1.locks.size).toBe(1);
    // This succeeds because `key1` is now unlocked
    await monitor2.lock('key1')();
    expect(monitor2.locks.size).toBe(1);
    // This is a noop, because `tran2` owns `key1`
    await monitor1.unlock('key1');
    expect(monitor2.locks.has('key1')).toBeTrue();
    expect(monitor1.locks.has('key1')).toBeFalse();
    await expect(
      monitor1.lock(['key1', 'write'], { timer: 0 }),
    ).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
    await monitor2.unlockAll();
    await monitor1.lock('key1')();
    expect(monitor1.locks.has('key1')).toBeTrue();
    expect(monitor1.locks.has('key2')).toBeTrue();
    await monitor1.unlockAll();
  });
  test('monitor wait for unlock is isolated to each monitor', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    // The `a` is already unlocked
    await monitor1.waitForUnlock('a');
    await monitor2.waitForUnlock('a');
    // Lock `a` for monitor1
    await monitor1.lock('a')();
    // Because `a` is not locked in `monitor2` this just resolves
    await monitor2.waitForUnlock('a');
    // But `monitor1` has locked `a` so this will timeout
    await expect(monitor1.waitForUnlock('a', { timer: 50 })).rejects.toThrow(
      errors.ErrorAsyncLocksTimeout,
    );
    await monitor1.unlockAll();
    await monitor1.waitForUnlock('a');
    await monitor1.unlockAll();
    await monitor2.unlockAll();
    // If you want to wait for unlock globally, use the `lockBox`
  });
  test('monitor `isLock` is isolated to each monitor', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    expect(monitor1.isLocked('a')).toBeFalse();
    expect(monitor2.isLocked('a')).toBeFalse();
    // Lock `a` for monitor1
    await monitor1.lock('a')();
    // Because `a` is not locked in `monitor2` this is false
    expect(monitor2.isLocked('a')).toBeFalse();
    // But `monitor1` has locked `a` so this will be true
    expect(monitor1.isLocked('a')).toBeTrue();
    await monitor1.unlockAll();
    expect(monitor1.isLocked('a')).toBeFalse();
    await monitor1.unlockAll();
    await monitor2.unlockAll();
    // If you want to test `isLocked` globally, use the `lockBox`
  });
  test('monitor `count` is isolated to each monitor', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    expect(monitor1.count).toBe(0);
    expect(monitor2.count).toBe(0);
    // Lock `a` for monitor1
    await monitor1.lock('a')();
    // Because `a` is not locked in `monitor2` this is 0
    expect(monitor2.count).toBe(0);
    // But `monitor1` has locked `a` so this will be 1
    expect(monitor1.count).toBe(1);
    await monitor1.unlockAll();
    expect(monitor1.count).toBe(0);
    await monitor1.unlockAll();
    await monitor2.unlockAll();
    // If you want to test `isLocked` globally, use the `lockBox`
  });
  test('withF', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor = new Monitor(lockBox, RWLockWriter);
    const p = withF([monitor.lock(['1'])], async ([monitor]) => {
      expect(monitor.isLocked()).toBe(true);
      expect(monitor.count).toBe(1);
    });
    expect(monitor.isLocked()).toBe(true);
    expect(monitor.count).toBe(1);
    await p;
    expect(monitor.isLocked()).toBe(false);
    expect(monitor.count).toBe(0);
    await monitor.unlockAll();
  });
  test('withG', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor = new Monitor(lockBox, RWLockWriter);
    const g1 = withG(
      [monitor.lock(['1', 'write'])],
      async function* ([monitor]): AsyncGenerator<string, string, void> {
        expect(monitor.isLocked()).toBe(true);
        expect(monitor.count).toBe(1);
        yield 'first';
        expect(monitor.isLocked()).toBe(true);
        expect(monitor.count).toBe(1);
        yield 'second';
        expect(monitor.isLocked()).toBe(true);
        expect(monitor.count).toBe(1);
        return 'last';
      },
    );
    expect(monitor.isLocked()).toBe(false);
    expect(monitor.count).toBe(0);
    for await (const _ of g1) {
      // It should be locked during iteration
      expect(monitor.isLocked()).toBe(true);
      expect(monitor.count).toBe(1);
    }
    // Note that for await consumes the returned value
    // But does not provide a way to retrieve it
    expect(await g1.next()).toStrictEqual({
      value: undefined,
      done: true,
    });
    expect(monitor.isLocked()).toBe(false);
    expect(monitor.count).toBe(0);
    // To actually get the value use while loop or explicit `next()`
    const g2 = withG(
      [monitor.lock(['1', 'write'])],
      async function* (): AsyncGenerator<string, string, void> {
        yield 'first';
        yield 'second';
        return 'last';
      },
    );
    // Unlocked before the first next
    expect(monitor.isLocked()).toBe(false);
    expect(monitor.count).toBe(0);
    const firstP = g2.next();
    expect(monitor.isLocked()).toBe(true);
    expect(monitor.count).toBe(1);
    await firstP;
    expect(monitor.isLocked()).toBe(true);
    expect(monitor.count).toBe(1);
    const secondP = g2.next();
    expect(monitor.isLocked()).toBe(true);
    expect(monitor.count).toBe(1);
    await secondP;
    expect(monitor.isLocked()).toBe(true);
    expect(monitor.count).toBe(1);
    const lastP = g2.next();
    expect(monitor.isLocked()).toBe(true);
    expect(monitor.count).toBe(1);
    await lastP;
    // Unlocked after the return
    expect(monitor.isLocked()).toBe(false);
    expect(monitor.count).toBe(0);
    await monitor.unlockAll();
  });
  test('lock count', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor = new Monitor(lockBox, RWLockWriter);
    const p = Promise.all([
      monitor.withF(['1'], async () => undefined),
      monitor.withF(['2', 'write'], async () => undefined),
      monitor.withF(['3', 'read'], async () => undefined),
      monitor.withF(['4', 'write'], async () => undefined),
      monitor.withF(['5', 'read'], async () => undefined),
    ]);
    expect(monitor.count).toBe(5);
    await p;
    await monitor.unlockAll();
  });
  test('wait for unlock', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor = new Monitor(lockBox, RWLockWriter);
    let value;
    const p1 = withF([monitor.lock(['1'])], async () => {
      value = 'p1';
      await testsUtils.sleep(100);
    });
    const p2 = monitor.waitForUnlock('1').then(() => {
      value = 'p2';
    });
    await p1;
    await p2;
    expect(value).toBe('p2');
    await monitor.unlockAll();
  });
  test('wait for unlock all', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor = new Monitor(lockBox, RWLockWriter);
    let value;
    const p1 = withF([monitor.lock(['1'], ['2', 'write'])], async () => {
      value = 'p1';
      await testsUtils.sleep(100);
    });
    const p2 = monitor.waitForUnlock().then(() => {
      value = 'p2';
    });
    await p1;
    await p2;
    expect(value).toBe('p2');
    await monitor.unlockAll();
  });
  test('unlock when exception is thrown', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor = new Monitor(lockBox, RWLockWriter);
    await expect(
      monitor.withF(['1'], ['2', 'write'], ['3', 'read'], async () => {
        expect(monitor.isLocked()).toBe(true);
        expect(monitor.count).toBe(3);
        throw new Error('oh no');
      }),
    ).rejects.toThrow('oh no');
    expect(monitor.isLocked()).toBe(false);
    expect(monitor.count).toBe(0);
    await monitor.unlockAll();
  });
  test('mutual exclusion', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    let value = 0;
    await Promise.all([
      monitor1.withF(['somelock'], async () => {
        const value_ = value + 1;
        await testsUtils.sleep(100);
        value = value_;
      }),
      monitor2.withF(['somelock'], async () => {
        const value_ = value + 1;
        await testsUtils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(2);
    value = 0;
    await Promise.all([
      (async () => {
        const g = monitor1.withG(
          ['somelock'],
          async function* (): AsyncGenerator {
            const value_ = value + 1;
            await testsUtils.sleep(100);
            value = value_;
            return 'last';
          },
        );
        for await (const _ of g) {
          // Noop
        }
      })(),
      (async () => {
        const g = monitor2.withG(
          ['somelock'],
          async function* (): AsyncGenerator {
            const value_ = value + 1;
            await testsUtils.sleep(100);
            value = value_;
            return 'last';
          },
        );
        for await (const _ of g) {
          // Noop
        }
      })(),
    ]);
    expect(value).toBe(2);
    await monitor1.unlockAll();
    await monitor2.unlockAll();
  });
  test('timeout', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    await withF([monitor1.lock(['1'], { timer: 0 })], async ([monitor1]) => {
      expect(monitor1.isLocked()).toBe(true);
      expect(monitor1.count).toBe(1);
      const f = jest.fn();
      await expect(
        withF([monitor2.lock(['1'], { timer: 100 })], f),
      ).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
      expect(f).not.toBeCalled();
      expect(monitor1.isLocked()).toBe(true);
      expect(monitor1.count).toBe(1);
    });
    expect(monitor1.isLocked()).toBe(false);
    expect(monitor1.count).toBe(0);
    expect(monitor2.isLocked()).toBe(false);
    expect(monitor2.count).toBe(0);
    await monitor1.withF(['1'], { timer: 100 }, async () => {
      const f = jest.fn();
      await expect(monitor2.withF(['1'], { timer: 100 }, f)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
    });
    const g = monitor1.withG(['1'], { timer: 100 }, async function* () {
      expect(monitor1.isLocked()).toBe(true);
      expect(monitor1.count).toBe(1);
      const f = jest.fn();
      const g = monitor2.withG(['1'], { timer: 100 }, f);
      await expect(g.next()).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
      expect(f).not.toBeCalled();
      expect(monitor1.isLocked()).toBe(true);
      expect(monitor1.count).toBe(1);
    });
    await g.next();
    expect(monitor1.isLocked()).toBe(false);
    expect(monitor1.count).toBe(0);
    await monitor1.unlockAll();
    await monitor2.unlockAll();
  });
  test('timeout waiting for unlock', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    await monitor1.waitForUnlock({ timer: 100 });
    await withF([monitor1.lock(['1'])], async ([monitor1]) => {
      await monitor1.waitForUnlock('2', { timer: 100 });
      await expect(monitor1.waitForUnlock('1', { timer: 100 })).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      await expect(monitor1.waitForUnlock({ timer: 100 })).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      await monitor2.waitForUnlock('1');
      await monitor2.waitForUnlock('2');
    });
    await monitor1.waitForUnlock({ timer: 100 });
    const g = withG([monitor1.lock(['1'])], async function* ([monitor1]) {
      await monitor1.waitForUnlock('2', { timer: 100 });
      await expect(monitor1.waitForUnlock('1', { timer: 100 })).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      await expect(monitor1.waitForUnlock({ timer: 100 })).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      await monitor2.waitForUnlock('1');
      await monitor2.waitForUnlock('2');
    });
    await g.next();
    await monitor1.waitForUnlock({ timer: 100 });
    await monitor1.unlockAll();
    await monitor2.unlockAll();
  });
  test('cannot upgrade or downgrade lock type on the same active key', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor = new Monitor(lockBox, RWLockWriter);
    await monitor.withF(['3', 'read'], async (monitor) => {
      const f = jest.fn();
      await expect(monitor.withF(['3', 'write'], f)).rejects.toThrow(
        errors.ErrorAsyncLocksMonitorLockType,
      );
      expect(f).not.toBeCalled();
    });
    await monitor.withF(['3', 'write'], async (monitor) => {
      const f = jest.fn();
      await expect(monitor.withF(['3', 'read'], f)).rejects.toThrow(
        errors.ErrorAsyncLocksMonitorLockType,
      );
      expect(f).not.toBeCalled();
    });
    await monitor.unlockAll();
  });
  test('prevent deadlocks with lock hierarchy via sorted lock keys', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    let value = 0;
    await Promise.all([
      monitor1.withF(['1'], ['2'], ['3'], ['4'], async () => {
        const value_ = value + 1;
        await testsUtils.sleep(100);
        value = value_;
      }),
      monitor2.withF('4', '3', '2', '1', async () => {
        const value_ = value + 1;
        await testsUtils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(2);
    value = 0;
    const g1 = monitor1.withG(['1'], ['2'], async function* (): AsyncGenerator {
      const value_ = value + 1;
      await testsUtils.sleep(100);
      value = value_;
      return 'last';
    });
    const g2 = monitor2.withG(['2'], ['1'], async function* (): AsyncGenerator {
      const value_ = value + 1;
      await testsUtils.sleep(100);
      value = value_;
      return 'last';
    });
    await Promise.all([
      (async () => {
        for await (const _ of g1) {
          // Noop
        }
      })(),
      (async () => {
        for await (const _ of g2) {
          // Noop
        }
      })(),
    ]);
    expect(value).toBe(2);
    await monitor1.unlockAll();
    await monitor2.unlockAll();
  });
  test('can map keys to Monitor locks', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor = new Monitor(lockBox, RWLockWriter);
    const keys = ['1', '2', '3', '4'];
    const locks: Array<RWLockRequest> = keys.map((key) => [key, 'write']);
    await monitor.withF(...locks, async () => {
      // NOP
    });
    await monitor.unlockAll();
  });
  test('release is idempotent', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor = new Monitor(lockBox, RWLockWriter);
    let lockAcquire = monitor.lock(['1'], ['2']);
    let [lockRelease] = await lockAcquire();
    await lockRelease();
    await lockRelease();
    expect(monitor.count).toBe(0);
    lockAcquire = monitor.lock(['2'], ['3']);
    [lockRelease] = await lockAcquire();
    await lockRelease();
    await lockRelease();
    expect(monitor.count).toBe(0);
    await monitor.unlockAll();
  });
  test('promise cancellation', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    const [release] = await monitor1.lock(['1'])();
    expect(monitor1.count).toBe(1);
    const lockAcquire = monitor2.lock(['1']);
    const lockAcquireP = lockAcquire();
    expect(lockBox.count).toBe(2);
    expect(monitor1.count).toBe(1);
    expect(monitor2.count).toBe(1);
    lockAcquireP.cancel(new Error('reason'));
    await expect(lockAcquireP).rejects.toThrow('reason');
    await release();
    expect(lockBox.count).toBe(0);
    expect(monitor1.count).toBe(0);
    expect(monitor2.count).toBe(0);
    await monitor1.unlockAll();
    await monitor2.unlockAll();
  });
  test('abort lock', async () => {
    const lockBox = new LockBox<RWLockWriter>();
    const monitor1 = new Monitor(lockBox, RWLockWriter);
    const monitor2 = new Monitor(lockBox, RWLockWriter);
    const [release] = await monitor1.lock(['1'])();
    const abc = new AbortController();
    // Abort after 10ms
    setTimeout(() => {
      abc.abort();
    }, 10);
    // Wait for 100ms, but we will expect abortion
    await expect(
      monitor2.lock(['1'], { signal: abc.signal, timer: 100 })(),
    ).rejects.toBe(undefined);
    await release();
    expect(lockBox.count).toBe(0);
    expect(monitor1.count).toBe(0);
    expect(monitor2.count).toBe(0);
    expect(monitor1.isLocked()).toBeFalse();
    expect(monitor2.isLocked()).toBeFalse();
    await monitor1.unlockAll();
    await monitor2.unlockAll();
  });
  describe('deadlocks', () => {
    // Deadlocks can happen when multiple monitors are concurrently locking keys.
    // Specifically when a monitor holds a lock that is awaited upon by other
    // monitors, while also awaiting a lock that is held by other monitors.
    // It is not sufficient for a monitor to be simply blocked by another monitor.
    // A deadlock is where neither monitor can make progress until one of them
    // stops attempting to lock the key the were awaiting.
    // Once a deadlock detected, it's important for the monitor that detected
    // it to also unlock the locks it is holding, because while it is no longer
    // in a deadlock once it stops awaiting, it is still blocking other monitors.
    // This unlocking process is not automatic. It is assumed that the user of
    // the monitor will react appropriately to the deadlock detection by wrapping
    // up whatever it was doing, and unlocking to allow another monitor to make
    // progress.
    // Deadlocks occur primarily due to programmer-error. When detecting a
    // deadlock the programmer should be change their logic to avoid
    // encountering a deadlock. Either through strict serialisation of deadlock
    // possible code or by switching to optimistic concurrency control.
    // This is why the deadlock detection is not enabled by default, it requires
    // sharing a map between all constructions of the `Monitor`.
    test('monitor1 [a:r, b:r] monitor2 [b:r, a:r] - no blocks', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock(['a', 'read'])();
      await monitor2.lock(['b', 'read'])();
      const p1 = monitor1.lock(['b', 'read'])();
      const p2 = monitor2.lock(['a', 'read'])();
      const results = await Promise.allSettled([p1, p2]);
      // Neither are blocked on one another
      expect(results).toEqual([
        { status: 'fulfilled', value: expect.any(Array) },
        { status: 'fulfilled', value: expect.any(Array) },
      ]);
    });
    test('monitor1 [a:r, b:r] monitor2 [b:w, a:r] - monitor1 is blocked', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock(['a', 'read'])();
      await monitor2.lock(['b', 'write'])();
      const p1 = monitor1.lock(['b', 'read'])();
      const p2 = monitor2.lock(['a', 'read'])();
      await expect(p2).resolves.toEqual(expect.any(Array));
      await monitor2.unlockAll();
      await expect(p1).resolves.toEqual(expect.any(Array));
    });
    test('monitor1 [a:r, b:w] monitor2 [b:r, a:r] - monitor1 is blocked', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock(['a', 'read'])();
      await monitor2.lock(['b', 'read'])();
      const p1 = monitor1.lock(['b', 'write'])();
      const p2 = monitor2.lock(['a', 'read'])();
      await expect(p2).resolves.toEqual(expect.any(Array));
      await monitor2.unlockAll();
      await expect(p1).resolves.toEqual(expect.any(Array));
    });
    test('monitor1 [a:r, b:w] monitor2 [b:w, a:r] - monitor1 is blocked', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock(['a', 'read'])();
      await monitor2.lock(['b', 'read'])();
      const p1 = monitor1.lock(['b', 'write'])();
      const p2 = monitor2.lock(['a', 'read'])();
      await expect(p2).resolves.toEqual(expect.any(Array));
      await monitor2.unlockAll();
      await expect(p1).resolves.toEqual(expect.any(Array));
    });
    test('monitor1 [a:w, b:r] monitor2 [b:r, a:r] - monitor2 is blocked', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock(['a', 'write'])();
      await monitor2.lock(['b', 'read'])();
      const p1 = monitor1.lock(['b', 'read'])();
      const p2 = monitor2.lock(['a', 'read'])();
      await expect(p1).resolves.toEqual(expect.any(Array));
      await monitor1.unlockAll();
      await expect(p2).resolves.toEqual(expect.any(Array));
    });
    test('monitor1 [a:r, b:r] monitor2 [b:r, a:w] - monitor2 is blocked', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock(['a', 'write'])();
      await monitor2.lock(['b', 'read'])();
      const p1 = monitor1.lock(['b', 'read'])();
      const p2 = monitor2.lock(['a', 'read'])();
      await expect(p1).resolves.toEqual(expect.any(Array));
      await monitor1.unlockAll();
      await expect(p2).resolves.toEqual(expect.any(Array));
    });
    test('monitor1 [a:w, b:r] monitor2 [b:r, a:w] - monitor2 is blocked', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock(['a', 'write'])();
      await monitor2.lock(['b', 'read'])();
      const p1 = monitor1.lock(['b', 'read'])();
      const p2 = monitor2.lock(['a', 'read'])();
      await expect(p1).resolves.toEqual(expect.any(Array));
      await monitor1.unlockAll();
      await expect(p2).resolves.toEqual(expect.any(Array));
    });
    test('monitor1 [a:r, b:w] monitor2 [b:r, a:w] - deadlock', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock(['a', 'read'])();
      await monitor2.lock(['b', 'read'])();
      const p1 = monitor1.lock(['b', 'write'])();
      const p2 = monitor2.lock(['a', 'write'])();
      await expect(p2).rejects.toThrow(errors.ErrorAsyncLocksMonitorDeadlock);
      await monitor2.unlockAll();
      await expect(p1).resolves.toEqual(expect.any(Array));
    });
    test('monitor1 [a:w, b:r] monitor2 [b:w, a:r] is a deadlock', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock(['a', 'write'])();
      await monitor2.lock(['b', 'write'])();
      const p1 = monitor1.lock(['b', 'read'])();
      const p2 = monitor2.lock(['a', 'read'])();
      await expect(p2).rejects.toThrow(errors.ErrorAsyncLocksMonitorDeadlock);
      await monitor2.unlockAll();
      await expect(p1).resolves.toEqual(expect.any(Array));
    });
    test('monitor1 [a:w, b:w] monitor2 [b:r, a:r] is a deadlock', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock(['a', 'write'])();
      await monitor2.lock(['b', 'read'])();
      const p1 = monitor1.lock(['b', 'write'])();
      const p2 = monitor2.lock(['a', 'read'])();
      await expect(p2).rejects.toThrow(errors.ErrorAsyncLocksMonitorDeadlock);
      await monitor2.unlockAll();
      await expect(p1).resolves.toEqual(expect.any(Array));
    });
    test('monitor1 [a:r, b:r] monitor2 [b:w, a:w] is a deadlock', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock(['a', 'read'])();
      await monitor2.lock(['b', 'write'])();
      const p1 = monitor1.lock(['b', 'read'])();
      const p2 = monitor2.lock(['a', 'write'])();
      await expect(p2).rejects.toThrow(errors.ErrorAsyncLocksMonitorDeadlock);
      await monitor2.unlockAll();
      await expect(p1).resolves.toEqual(expect.any(Array));
    });
    test('monitor1 [a:w, b:w] monitor2 [b:w, a:w] is a deadlock', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock('a')();
      await monitor2.lock('b')();
      const p1 = monitor1.lock('b')();
      const p2 = monitor2.lock('a')();
      await expect(p2).rejects.toThrow(errors.ErrorAsyncLocksMonitorDeadlock);
      expect(monitor2.isLocked('b')).toBeTrue();
      await monitor2.unlock('b');
      expect(monitor2.isLocked('b')).toBeFalse();
      await expect(p1).resolves.toEqual(expect.any(Array));
      expect(monitor1.count).toBe(2);
      expect(monitor2.count).toBe(0);
    });
    test('monitor1 [a:w, b:w] monitor2 [b:w, c:w] monitor3 [c:w, a:w] is a 3-way deadlock', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const locksPending = new Map();
      const monitor1 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor2 = new Monitor(lockBox, RWLockWriter, locksPending);
      const monitor3 = new Monitor(lockBox, RWLockWriter, locksPending);
      await monitor1.lock('a')();
      await monitor2.lock('b')();
      await monitor3.lock('c')();
      const p1 = monitor1.lock('b')();
      const p2 = monitor2.lock('c')();
      const p3 = monitor3.lock('a')();
      // P2 realises it's in a deadlock
      await expect(p2).rejects.toThrow(errors.ErrorAsyncLocksMonitorDeadlock);
      // P2 must unlock `b` as it is blocking P1
      await monitor2.unlockAll();
      // P1 will succeed
      await expect(p1).resolves.toEqual(expect.any(Array));
      // P1 must unlock `a` as it is blocking P3
      await monitor1.unlockAll();
      await expect(p3).resolves.toEqual(expect.any(Array));
    });
    test('monitor deadlock to be resolved with timeout', async () => {
      const lockBox = new LockBox<RWLockWriter>();
      const monitor1 = new Monitor(lockBox, RWLockWriter);
      const monitor2 = new Monitor(lockBox, RWLockWriter);
      await monitor1.lock('foo')();
      await monitor2.lock('bar')();
      const p1 = monitor1.lock('bar', { timer: 50 })();
      const p2 = monitor2.lock('foo', { timer: 50 })();
      const results = await Promise.allSettled([p1, p2]);
      expect(
        results.every(
          (r) =>
            r.status === 'rejected' &&
            r.reason instanceof errors.ErrorAsyncLocksTimeout,
        ),
      ).toBeTrue();
      await monitor1.unlockAll();
      await monitor2.unlockAll();
    });
  });
});
