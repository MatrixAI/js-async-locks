import { withF, withG } from '@matrixai/resources';
import RWLockWriter from '@/RWLockWriter';
import * as testUtils from './utils';

describe(RWLockWriter.name, () => {
  test('withF', async () => {
    const lock = new RWLockWriter();
    const p1 = withF([lock.acquireRead], async ([lock]) => {
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
    const p2 = withF([lock.acquireWrite], async ([lock]) => {
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
    const g1 = withG(
      [lock.acquireRead],
      async function* ([lock]): AsyncGenerator<string, string, void> {
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
      },
    );
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
    const g2 = withG([lock.acquireRead], async function* (): AsyncGenerator<
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
    const g1 = withG(
      [lock.acquireWrite],
      async function* ([lock]): AsyncGenerator<string, string, void> {
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
      },
    );
    for await (const _ of g1) {
      // It should be locked during iteration
      expect(lock.isLocked()).toBe(true);
      expect(lock.readerCount).toBe(0);
      expect(lock.writerCount).toBe(1);
    }
    // To actually get the value use while loop or explicit `next()`
    const g2 = withG([lock.acquireWrite], async function* (): AsyncGenerator<
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
    const p1 = withF([lock.acquireRead], async () => {
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
  test('wait for unlock on write', async () => {
    const lock = new RWLockWriter();
    let value;
    const p1 = withF([lock.acquireWrite], async () => {
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
        await testUtils.sleep(100);
        value = value_;
      }),
      lock.withReadF(async () => {
        const value_ = value + 1;
        await testUtils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(1);
    value = 0;
    await Promise.all([
      lock.withWriteF(async () => {
        const value_ = value + 1;
        await testUtils.sleep(100);
        value = value_;
      }),
      lock.withWriteF(async () => {
        const value_ = value + 1;
        await testUtils.sleep(100);
        value = value_;
      }),
    ]);
    expect(value).toBe(2);
    value = 0;
    await Promise.all([
      (async () => {
        const g = lock.withReadG(async function* (): AsyncGenerator {
          const value_ = value + 1;
          await testUtils.sleep(100);
          value = value_;
          return 'last';
        });
        for await (const _ of g) {
        }
      })(),
      (async () => {
        const g = lock.withReadG(async function* (): AsyncGenerator {
          const value_ = value + 1;
          await testUtils.sleep(100);
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
          await testUtils.sleep(100);
          value = value_;
          return 'last';
        });
        for await (const _ of g) {
        }
      })(),
      (async () => {
        const g = lock.withWriteG(async function* (): AsyncGenerator {
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
    // Notice that `read2` happens first
    // This can chnage if `read2` takes longer to do
    expect(order).toStrictEqual([
      'read2',
      'read1',
      'write1',
      'read4',
      'read3',
      'write2',
    ]);
  });
});
