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
  isLocked(...params: Array<unknown>): boolean;
  waitForUnlock(timeout?: number): Promise<void>;
  withF<T>(...params: Array<unknown>): Promise<T>;
  withG<T, TReturn, TNext>(
    ...params: Array<unknown>
  ): AsyncGenerator<T, TReturn, TNext>;
}

type MultiLockRequest<L extends Lockable = Lockable> = [
  key: ToString,
  lockConstructor: new () => L,
  ...lockingParams: Parameters<L['lock']>,
];

type MultiLockAcquire<L extends Lockable = Lockable> = [
  key: ToString,
  lockAcquire: ResourceAcquire<L>,
  ...lockingParams: Parameters<L['lock']>,
];

type MultiLockAcquired<L extends Lockable = Lockable> = [
  key: ToString,
  lock: L,
  ...lockingParams: Parameters<L['lock']>,
];

export type {
  POJO,
  ToString,
  Lockable,
  MultiLockRequest,
  MultiLockAcquire,
  MultiLockAcquired,
};
