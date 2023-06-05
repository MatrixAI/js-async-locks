import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type { ResourceRelease } from '@matrixai/resources';
import type { Timer } from '@matrixai/timer';

/**
 * Plain data dictionary
 */
type POJO = { [key: string]: any };

/**
 * Deconstructed promise
 */
type PromiseDeconstructed<T> = {
  p: Promise<T>;
  resolveP: (value: T | PromiseLike<T>) => void;
  rejectP: (reason?: any) => void;
};

/**
 * Derived from `ResourceAcquire`, this is just cancellable too
 */
type ResourceAcquireCancellable<Resource> = (
  resources?: readonly any[],
) => PromiseCancellable<readonly [ResourceRelease, Resource?]>;

interface Lockable {
  count: number;
  lock(...params: Array<unknown>): ResourceAcquireCancellable<Lockable>;
  isLocked(...params: Array<unknown>): boolean;
  waitForUnlock(...params: Array<unknown>): PromiseCancellable<void>;
  withF<T>(...params: Array<unknown>): Promise<T>;
  withG<T, TReturn, TNext>(
    ...params: Array<unknown>
  ): AsyncGenerator<T, TReturn, TNext>;
}

type LockRequest<L extends Lockable = Lockable> = [
  key: string,
  lockConstructor: new () => L,
  ...lockingParams: Parameters<L['lock']>,
];

type LockAcquireCancellable<L extends Lockable = Lockable> = [
  key: string,
  lockAcquire: ResourceAcquireCancellable<L>,
  ...lockingParams: Parameters<L['lock']>,
];

type LockAcquired<L extends Lockable = Lockable> = [
  key: string,
  lock: L,
  ...lockingParams: Parameters<L['lock']>,
];

type RWLockRequest =
  | [key: string, type?: 'read' | 'write', ctx?: Partial<ContextTimedInput>]
  | [key: string, ctx?: Partial<ContextTimedInput>];

type ContextTimed = {
  signal: AbortSignal;
  timer: Timer;
};

type ContextTimedInput = {
  signal: AbortSignal;
  timer: Timer | number;
};

export type {
  POJO,
  PromiseDeconstructed,
  ResourceAcquireCancellable,
  Lockable,
  LockRequest,
  LockAcquireCancellable,
  LockAcquired,
  RWLockRequest,
  ContextTimed,
  ContextTimedInput,
};
