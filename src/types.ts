import type { ResourceAcquire } from '@matrixai/resources';

/**
 * Plain data dictionary
 */
type POJO = { [key: string]: any };

/**
 * Any type that can be turned into a string
 */
interface ToString {
  toString(): string;
}

interface Lockable {
  count: number;
  lock(...params: Array<unknown>): ResourceAcquire<Lockable>;
  isLocked(): boolean;
  waitForUnlock(timeout?: number): Promise<void>;
}

export type { POJO, ToString, Lockable };
