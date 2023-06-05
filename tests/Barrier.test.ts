import Barrier from '@/Barrier';
import * as errors from '@/errors';
import * as testsUtils from './utils';

describe(Barrier.name, () => {
  test('barrier only takes count >= 0', async () => {
    await expect(Barrier.createBarrier(-1)).rejects.toThrow(RangeError);
  });
  test('barrier blocks until concurrent count is reached', async () => {
    const barrier = await Barrier.createBarrier(3);
    let called1 = false;
    let called2 = false;
    const t1 = async () => {
      await barrier.wait();
      called1 = true;
    };
    const t2 = async () => {
      await barrier.wait();
      called2 = true;
    };
    const p1 = t1();
    const p2 = t2();
    await testsUtils.sleep(1);
    expect(called1).toBe(false);
    expect(called2).toBe(false);
    await barrier.wait();
    const results = await Promise.allSettled([p1, p2]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(called1).toBe(true);
    expect(called2).toBe(true);
  });
  test('barrier does not block if concurrent count starts as 0', async () => {
    const barrier = await Barrier.createBarrier(0);
    let called1 = false;
    let called2 = false;
    const t1 = async () => {
      await barrier.wait();
      called1 = true;
    };
    const t2 = async () => {
      await barrier.wait();
      called2 = true;
    };
    const p1 = t1();
    const p2 = t2();
    await testsUtils.sleep(1);
    expect(called1).toBe(true);
    expect(called2).toBe(true);
    const results = await Promise.allSettled([p1, p2]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  });
  test('barrier does not block if concurrent count starts as 1', async () => {
    const barrier = await Barrier.createBarrier(1);
    let called1 = false;
    let called2 = false;
    const t1 = async () => {
      await barrier.wait();
      called1 = true;
    };
    const t2 = async () => {
      await barrier.wait();
      called2 = true;
    };
    const p1 = t1();
    const p2 = t2();
    await testsUtils.sleep(1);
    expect(called1).toBe(true);
    expect(called2).toBe(true);
    const results = await Promise.allSettled([p1, p2]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  });
  test('barrier wait with timeout', async () => {
    const barrier = await Barrier.createBarrier(2);
    let called1 = false;
    const t1 = async () => {
      await expect(barrier.wait({ timer: 10 })).rejects.toThrow(
        errors.ErrorAsyncLocksTimeout,
      );
      called1 = true;
    };
    const p1 = t1();
    expect(called1).toBe(false);
    await testsUtils.sleep(5);
    expect(called1).toBe(false);
    await testsUtils.sleep(10);
    expect(called1).toBe(true);
    await p1;
  });
});
