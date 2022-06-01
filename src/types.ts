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
  withF<T>(...params: Array<unknown>): Promise<T>;
  withG<T, TReturn, TNext>(
    ...params: Array<unknown>
  ): AsyncGenerator<T, TReturn, TNext>;
}

type LockRequest<L extends Lockable = Lockable> = [
  key: ToString,
  lockConstructor: new () => L,
  ...lockingParams: Parameters<L['lock']>,
];

export type { POJO, ToString, Lockable, LockRequest };
