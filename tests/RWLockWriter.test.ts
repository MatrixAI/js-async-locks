import { withF, withG } from '@matrixai/resources';
import RWLockWriter from '@/RWLockWriter';
import * as utils from '@/utils';
import * as errors from '@/errors';

describe(RWLockWriter.name, () => {
  test('withF', async () => {
    const lock = new RWLockWriter();
    const p1 = withF([lock.read()], async ([lock]) => {
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(1);
      expect(lock.writerCount).toBe(0);
    });
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(1);
    expect(lock.writerCount).toBe(0);
    await p1;
    expect(lock.isLocked()).toBe(false);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(0);
    const p2 = withF([lock.write()], async ([lock]) => {
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(0);
      expect(lock.writerCount).toBe(1);
    });
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(1);
    await p2;
    expect(lock.isLocked()).toBe(false);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(0);
  });
  test('withG on read', async () => {
    const lock = new RWLockWriter();
    const g1 = withG([lock.read()], async function* ([lock]): AsyncGenerator<
      string,
      string,
      void
    > {
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(1);
      expect(lock.writerCount).toBe(0);
      yield 'first';
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(1);
      expect(lock.writerCount).toBe(0);
      yield 'second';
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(1);
      expect(lock.writerCount).toBe(0);
      return 'last';
    });
    for await (const _ of g1) {
      // It should be locked during iteration
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(1);
      expect(lock.writerCount).toBe(0);
    }
    // Note that for await consumes the returned value
    // But does not provide a way to retrieve it
    expect(await g1.next()).toStrictEqual({
      value: undefined,
      done: true,
    });
    expect(lock.isLocked()).toBe(false);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(0);
    // To actually get the value use while loop or explicit `next()`
    const g2 = withG([lock.read()], async function* (): AsyncGenerator<
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
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(0);
    const firstP = g2.next();
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(1);
    expect(lock.writerCount).toBe(0);
    await firstP;
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(1);
    expect(lock.writerCount).toBe(0);
    const secondP = g2.next();
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(1);
    expect(lock.writerCount).toBe(0);
    await secondP;
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(1);
    expect(lock.writerCount).toBe(0);
    const lastP = g2.next();
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(1);
    expect(lock.writerCount).toBe(0);
    await lastP;
    // Unlocked after the return
    expect(lock.isLocked()).toBe(false);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(0);
  });
  test('withG on write', async () => {
    const lock = new RWLockWriter();
    const g1 = withG([lock.write()], async function* ([lock]): AsyncGenerator<
      string,
      string,
      void
    > {
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(0);
      expect(lock.writerCount).toBe(1);
      yield 'first';
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(0);
      expect(lock.writerCount).toBe(1);
      yield 'second';
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(0);
      expect(lock.writerCount).toBe(1);
      return 'last';
    });
    for await (const _ of g1) {
      // It should be locked during iteration
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(0);
      expect(lock.writerCount).toBe(1);
    }
    // To actually get the value use while loop or explicit `next()`
    const g2 = withG([lock.write()], async function* (): AsyncGenerator<
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
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(0);
    const firstP = g2.next();
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(1);
    await firstP;
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(1);
    const secondP = g2.next();
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(1);
    await secondP;
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(1);
    const lastP = g2.next();
    expect(lock.isLocked()).toBe(true);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(1);
    await lastP;
    // Unlocked after the return
    expect(lock.isLocked()).toBe(false);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(0);
  });
  test('lock count', async () => {
    const lock = new RWLockWriter();
    const p = Promise.all([
      lock.withReadF(async () => undefined),
      lock.withReadF(async () => undefined),
      lock.withWriteF(async () => undefined),
      lock.withWriteF(async () => undefined),
    ]);
    expect(lock.readerCount).toBe(2);
    expect(lock.writerCount).toBe(2);
    await p;
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(0);
  });
  test('wait for unlock on read', async () => {
    const lock = new RWLockWriter();
    let value;
    const p1 = withF([lock.read()], async () => {
      value = 'p1';
      await utils.sleep(100);
    });
    const p2 = lock.waitForUnlock().then(() => {
      value = 'p2';
    });
    await p1;
    await p2;
    expect(value).toBe('p2');
  });
  test('wait for unlock on write', async () => {
    const lock = new RWLockWriter();
    let value;
    const p1 = withF([lock.write()], async () => {
      value = 'p1';
      await utils.sleep(100);
    });
    const p2 = lock.waitForUnlock().then(() => {
      value = 'p2';
    });
    await p1;
    await p2;
    expect(value).toBe('p2');
  });
  test('unlock when exception is thrown', async () => {
    const lock = new RWLockWriter();
    await expect(
      lock.withReadF(async () => {
        expect(lock.isLocked()).toBe(true);
        expect(lock.readerCount).toBe(1);
        throw new Error('oh no');
      }),
    ).rejects.toThrow('oh no');
    expect(lock.isLocked()).toBe(false);
    expect(lock.readerCount).toBe(0);
    await expect(
      lock.withWriteF(async () => {
        expect(lock.isLocked()).toBe(true);
        expect(lock.writerCount).toBe(1);
        throw new Error('oh no');
      }),
    ).rejects.toThrow('oh no');
    expect(lock.isLocked()).toBe(false);
    expect(lock.writerCount).toBe(0);
  });
  test('mutual exclusion', async () => {
    const lock = new RWLockWriter();
    let value = 0;
    await Promise.all([
      lock.withReadF(async () => {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
      }),
      lock.withReadF(async () => {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(1);
    value = 0;
    await Promise.all([
      lock.withWriteF(async () => {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
      }),
      lock.withWriteF(async () => {
        const value_ = value + 1;
        await utils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(2);
    value = 0;
    await Promise.all([
      (async () => {
        const g = lock.withReadG(async function* (): AsyncGenerator {
          const value_ = value + 1;
          await utils.sleep(100);
          value = value_;
          return 'last';
        });
        for await (const _ of g) {
        }
      })(),
      (async () => {
        const g = lock.withReadG(async function* (): AsyncGenerator {
          const value_ = value + 1;
          await utils.sleep(100);
          value = value_;
          return 'last';
        });
        for await (const _ of g) {
        }
      })(),
    ]);
    expect(value).toBe(1);
    value = 0;
    await Promise.all([
      (async () => {
        const g = lock.withWriteG(async function* (): AsyncGenerator {
          const value_ = value + 1;
          await utils.sleep(100);
          value = value_;
          return 'last';
        });
        for await (const _ of g) {
        }
      })(),
      (async () => {
        const g = lock.withWriteG(async function* (): AsyncGenerator {
          const value_ = value + 1;
          await utils.sleep(100);
          value = value_;
          return 'last';
        });
        for await (const _ of g) {
        }
      })(),
    ]);
    expect(value).toBe(2);
  });
  test('order of operations', async () => {
    // Write-preferring order
    const lock = new RWLockWriter();
    const order: Array<string> = [];
    const p1 = lock.withReadF(async () => {
      order.push('read1');
    });
    const p2 = lock.withReadF(async () => {
      order.push('read2');
    });
    const p3 = lock.withWriteF(async () => {
      order.push('write1');
    });
    const p4 = lock.withReadF(async () => {
      order.push('read3');
    });
    const p5 = lock.withReadF(async () => {
      order.push('read4');
    });
    const p6 = lock.withWriteF(async () => {
      order.push('write2');
    });
    await p1;
    await p2;
    await p3;
    await p4;
    await p5;
    await p6;
    expect(order).toStrictEqual([
      'read1',
      'read2',
      'write1',
      'read3',
      'read4',
      'write2',
    ]);
  });
  test('timeout', async () => {
    const lock = new RWLockWriter();
    await withF([lock.read(0)], async ([lock]) => {
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(1);
      expect(lock.writerCount).toBe(0);
      const f = jest.fn();
      await expect(withF([lock.write(100)], f)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(1);
      expect(lock.writerCount).toBe(0);
    });
    expect(lock.isLocked()).toBe(false);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(0);
    await withF([lock.write(0)], async ([lock]) => {
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(0);
      expect(lock.writerCount).toBe(1);
      const f = jest.fn();
      await expect(withF([lock.read(100)], f)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(0);
      expect(lock.writerCount).toBe(1);
    });
    await lock.withReadF(async () => {
      const f = jest.fn();
      await expect(lock.withWriteF(f, 100)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
    }, 100);
    await lock.withWriteF(async () => {
      const f = jest.fn();
      await expect(lock.withReadF(f, 100)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
    }, 100);
    await lock.withWriteF(async () => {
      const f = jest.fn();
      await expect(lock.withWriteF(f, 100)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      expect(f).not.toBeCalled();
    }, 100);
    const gRead = lock.withReadG(async function* () {
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(1);
      expect(lock.writerCount).toBe(0);
      const f = jest.fn();
      const g = lock.withWriteG(f, 100);
      await expect(g.next()).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
      expect(f).not.toBeCalled();
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(1);
      expect(lock.writerCount).toBe(0);
    });
    await gRead.next();
    const gWrite = lock.withWriteG(async function* () {
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(0);
      expect(lock.writerCount).toBe(1);
      const f1 = jest.fn();
      const g1 = lock.withReadG(f1, 100);
      await expect(g1.next()).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
      expect(f1).not.toBeCalled();
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(0);
      expect(lock.writerCount).toBe(1);
      const f2 = jest.fn();
      const g2 = lock.withWriteG(f2, 100);
      await expect(g2.next()).rejects.toThrow(errors.ErrorAsyncLocksTimeout);
      expect(f2).not.toBeCalled();
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(0);
      expect(lock.writerCount).toBe(1);
    });
    await gWrite.next();
    expect(lock.isLocked()).toBe(false);
    expect(lock.readerCount).toBe(0);
    expect(lock.writerCount).toBe(0);
  });
  test('timeout waiting for unlock', async () => {
    const lock = new RWLockWriter();
    await lock.waitForUnlock(100);
    await withF([lock.read()], async ([lock]) => {
      await expect(lock.waitForUnlock(100)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
    });
    await lock.waitForUnlock(100);
    const g = withG([lock.write()], async function* ([lock]) {
      await expect(lock.waitForUnlock(100)).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
    });
    await g.next();
    await lock.waitForUnlock(100);
  });
});
