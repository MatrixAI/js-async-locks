import type { PromiseCancellable } from '@matrixai/async-cancellable';
import type {
  ResourceAcquireCancellable,
  Lockable,
  ContextTimed,
  ContextTimedInput,
} from './types';
import { withF, withG } from '@matrixai/resources';
import * as utils from './utils';
import * as errors from './errors';

type Task = {
  task: () => void;
  weight: number;
  abortHandler: () => void;
  aborted?: boolean;
};

class Semaphore implements Lockable {
  public readonly limit: number;
  public readonly priority: boolean;

  protected _count: number = 0;
  protected currentWeight: number = 0;
  protected queue: Array<Task> = [];
  protected abortQueueMap: WeakMap<() => void, Task> = new WeakMap();

  public constructor(limit: number, priority: boolean = false) {
    if (limit < 1) {
      throw new RangeError('Semaphore must be constructed with `limit` >= 1');
    }
    this.limit = limit;
    this.priority = priority;
  }

  public get count(): number {
    return this._count;
  }

  /**
   * This will be true synchronously upon calling `this.lock()()`.
   */
  public isLocked(): boolean {
    return this._count > 0;
  }

  public lock(
    ...params:
      | [weight?: number, ctx?: Partial<ContextTimedInput>]
      | [weight?: number]
      | [ctx?: Partial<ContextTimedInput>]
      | []
  ): ResourceAcquireCancellable<Semaphore> {
    const weight =
      (params.length === 2
        ? params[0]
        : typeof params[0] === 'number'
        ? params[0]
        : undefined) ?? 1;
    let ctx =
      params.length === 2
        ? params[1]
        : typeof params[0] !== 'number'
        ? params[0]
        : undefined;
    if (weight < 1) {
      throw new RangeError('Semaphore must be locked with `weight` >= 1');
    }
    ctx = ctx != null ? { ...ctx } : {};
    return () => {
      return utils.setupTimedCancellable(
        (ctx: ContextTimed, weight: number) => {
          this._count++;
          // Change `any` time to the resource thing
          const {
            p: lockP,
            resolveP: resolveLockP,
            rejectP: rejectLockP,
          } = utils.promise<any>();
          // If signal is already aborted, then we can reject with reason
          if (ctx.signal.aborted) {
            this._count--;
            rejectLockP(ctx.signal.reason);
            return lockP;
          }
          const abortHandler = () => {
            this._count--;
            const taskToAbort = this.abortQueueMap.get(abortHandler);
            if (taskToAbort != null) {
              taskToAbort.aborted = true;
            }
            rejectLockP(ctx.signal.reason);
          };
          let released = false;
          const task = {
            task: () => {
              this.currentWeight += weight;
              ctx.signal.removeEventListener('abort', abortHandler);
              resolveLockP([
                async () => {
                  if (released) return;
                  released = true;
                  this._count--;
                  this.currentWeight -= weight;
                  this.processQueue();
                },
                this,
              ]);
            },
            weight,
            abortHandler,
            aborted: false,
          };
          ctx.signal.addEventListener('abort', abortHandler, { once: true });
          this.abortQueueMap.set(abortHandler, task);
          this.insertQueue(task);
          this.processQueue();
          return lockP;
        },
        true,
        Infinity,
        errors.ErrorAsyncLocksTimeout,
        ctx!,
        [weight],
      );
    };
  }

  public waitForUnlock(
    ...params:
      | [weight?: number, ctx?: Partial<ContextTimedInput>]
      | [weight?: number]
      | [ctx?: Partial<ContextTimedInput>]
      | []
  ): PromiseCancellable<void> {
    const weight =
      (params.length === 2
        ? params[0]
        : typeof params[0] === 'number'
        ? params[0]
        : undefined) ?? 1;
    let ctx =
      params.length === 2
        ? params[1]
        : typeof params[0] !== 'number'
        ? params[0]
        : undefined;
    if (weight < 1) {
      throw new RangeError('Semaphore must be locked with `weight` >= 1');
    }
    ctx = ctx != null ? { ...ctx } : {};
    return utils.setupTimedCancellable(
      (ctx: ContextTimed, weight: number) => {
        const {
          p: waitP,
          resolveP: resolveWaitP,
          rejectP: rejectWaitP,
        } = utils.promise<void>();
        if (ctx.signal.aborted) {
          rejectWaitP(ctx.signal.reason);
          return waitP;
        }
        const abortHandler = () => {
          const taskToAbort = this.abortQueueMap.get(abortHandler);
          if (taskToAbort != null) {
            taskToAbort.aborted = true;
          }
          rejectWaitP(ctx.signal.reason);
        };
        const task = {
          task: () => {
            ctx.signal.removeEventListener('abort', abortHandler);
            resolveWaitP();
          },
          weight,
          abortHandler,
          aborted: false,
        };
        ctx.signal.addEventListener('abort', abortHandler, { once: true });
        this.abortQueueMap.set(abortHandler, task);
        this.insertQueue(task);
        this.processQueue();
        return waitP;
      },
      true,
      Infinity,
      errors.ErrorAsyncLocksTimeout,
      ctx!,
      [weight],
    );
  }

  public withF<T>(
    ...params: [
      ...(
        | [weight?: number, ctx?: Partial<ContextTimedInput>]
        | [weight?: number]
        | [ctx?: Partial<ContextTimedInput>]
        | []
      ),
      (semaphore: Semaphore) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (semaphore: Semaphore) => Promise<T>;
    return withF([this.lock(...(params as any))], ([semaphore]) =>
      f(semaphore),
    );
  }

  public withG<T, TReturn, TNext>(
    ...params: [
      ...(
        | [weight?: number, ctx?: Partial<ContextTimedInput>]
        | [weight?: number]
        | [ctx?: Partial<ContextTimedInput>]
        | []
      ),
      (semaphore: Semaphore) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      semaphore: Semaphore,
    ) => AsyncGenerator<T, TReturn, TNext>;
    return withG([this.lock(...(params as any))], ([semaphore]) =>
      g(semaphore),
    );
  }

  protected insertQueue(task: Task) {
    // If prioritising small weights, then perform insertion sort.
    // The resulting queue will be sorted from largest weights to smallest weights.
    if (this.priority) {
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1].weight < task.weight) {
        i--;
      }
      this.queue.splice(i, 0, task);
    } else {
      // Enqueuing into the queue is unfortunately not O(1).
      this.queue.unshift(task);
    }
  }

  protected processQueue() {
    while (
      this.queue.length > 0 &&
      this.currentWeight + this.queue[this.queue.length - 1].weight <=
        this.limit
    ) {
      const task = this.queue.pop()!;
      if (!task.aborted) {
        task.task();
      }
    }
  }
}

export default Semaphore;
