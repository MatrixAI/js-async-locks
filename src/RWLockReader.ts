import type { ResourceRelease } from '@matrixai/resources';
import type {
  ResourceAcquireCancellable,
  Lockable,
  ContextTimed,
  ContextTimedInput,
} from './types.js';
import { PromiseCancellable } from '@matrixai/async-cancellable';
import { withF, withG } from '@matrixai/resources';
import Lock from './Lock.js';
import * as utils from './utils.js';
import * as errors from './errors.js';

/**
 * Read-preferring read write lock
 */
class RWLockReader implements Lockable {
  protected readersLock: Lock = new Lock();
  protected writersLock: Lock = new Lock();
  protected writersRelease: ResourceRelease;
  protected readerCountBlocked: number = 0;
  protected _readerCount: number = 0;
  protected _writerCount: number = 0;

  protected acquireWritersLockP: PromiseCancellable<
    readonly [ResourceRelease, Lock?]
  >;

  public get count(): number {
    return this.readerCount + this.writerCount;
  }

  public get readerCount(): number {
    return this._readerCount + this.readerCountBlocked;
  }

  public get writerCount(): number {
    return this._writerCount;
  }

  /**
   * Check if locked
   * If passed `type`, it will also check that the active lock is of that type
   */
  public isLocked(type?: 'read' | 'write'): boolean {
    if (type === 'read') {
      return this._readerCount > 0 || this.readersLock.isLocked();
    } else if (type === 'write') {
      return this._readerCount === 0 && this.writersLock.isLocked();
    } else {
      return (
        this._readerCount > 0 ||
        this.readersLock.isLocked() ||
        this.writersLock.isLocked()
      );
    }
  }

  public lock(
    ...params:
      | [type?: 'read' | 'write', ctx?: Partial<ContextTimedInput>]
      | [type?: 'read' | 'write']
      | [ctx?: Partial<ContextTimedInput>]
      | []
  ): ResourceAcquireCancellable<RWLockReader> {
    const type =
      (params.length === 2
        ? params[0]
        : typeof params[0] === 'string'
        ? params[0]
        : undefined) ?? 'write';
    const ctx =
      params.length === 2
        ? params[1]
        : typeof params[0] !== 'string'
        ? params[0]
        : undefined;
    switch (type) {
      case 'read':
        return this.read(ctx);
      case 'write':
        return this.write(ctx);
    }
  }

  public read(
    ctx?: Partial<ContextTimedInput>,
  ): ResourceAcquireCancellable<RWLockReader> {
    ctx = ctx != null ? { ...ctx } : {};
    return () => {
      return utils.setupTimedCancellable(
        async (ctx: ContextTimed) => {
          ++this.readerCountBlocked;
          const acquireReadersLock = this.readersLock.lock(ctx);
          const acquireReadersLockP = acquireReadersLock();
          let readersRelease: ResourceRelease;
          try {
            [readersRelease] = await acquireReadersLockP;
            --this.readerCountBlocked;
          } catch (e) {
            --this.readerCountBlocked;
            throw e;
          }
          const readerCount = ++this._readerCount;
          // The first reader locks
          if (readerCount === 1) {
            const acquireWritersLock = this.writersLock.lock(ctx);
            this.acquireWritersLockP = acquireWritersLock();
            try {
              [this.writersRelease] = await this.acquireWritersLockP;
              await readersRelease();
            } catch (e) {
              await readersRelease();
              --this._readerCount;
              throw e;
            }
          } else {
            await readersRelease();
            await this.acquireWritersLockP.catch(() => {});
          }
          let released = false;
          return [
            async () => {
              if (released) return;
              released = true;
              [readersRelease] = await this.readersLock.lock()();
              const readerCount = --this._readerCount;
              // The last reader unlocks
              if (readerCount === 0) {
                await this.writersRelease();
              }
              await readersRelease();
            },
            this,
          ] as const;
        },
        true,
        Infinity,
        errors.ErrorAsyncLocksTimeout,
        ctx!,
        [],
      );
    };
  }

  public write(
    ctx?: Partial<ContextTimedInput>,
  ): ResourceAcquireCancellable<RWLockReader> {
    return () => {
      ++this._writerCount;
      const acquireWritersLock = this.writersLock.lock(ctx);
      const acquireWritersLockP = acquireWritersLock();
      return acquireWritersLockP.then(
        ([release]) => {
          let released = false;
          return [
            async () => {
              if (released) return;
              released = true;
              await release();
              --this._writerCount;
            },
            this,
          ] as const;
        },
        (e) => {
          --this._writerCount;
          throw e;
        },
        (signal) => {
          signal.addEventListener(
            'abort',
            () => {
              acquireWritersLockP.cancel(signal.reason);
            },
            { once: true },
          );
        },
      );
    };
  }

  public waitForUnlock(
    ctx?: Partial<ContextTimedInput>,
  ): PromiseCancellable<void> {
    const waitReadersLockP = this.readersLock.waitForUnlock(ctx);
    const waitWritersLockP = this.writersLock.waitForUnlock(ctx);
    return PromiseCancellable.all([waitReadersLockP, waitWritersLockP]).then(
      () => {},
      undefined,
      (signal) => {
        signal.addEventListener(
          'abort',
          () => {
            waitReadersLockP.cancel(signal.reason);
            waitWritersLockP.cancel(signal.reason);
          },
          { once: true },
        );
      },
    );
  }

  public withF<T>(
    ...params: [
      ...(
        | [type?: 'read' | 'write', ctx?: Partial<ContextTimedInput>]
        | [type?: 'read' | 'write']
        | [ctx?: Partial<ContextTimedInput>]
        | []
      ),
      (lock: RWLockReader) => Promise<T>,
    ]
  ): Promise<T> {
    let type: 'read' | 'write';
    if (params.length === 2) {
      type = params.shift() as 'read' | 'write';
    } else {
      if (typeof params[0] === 'string') {
        type = params.shift() as 'read' | 'write';
      } else if (typeof params[0] == null) {
        params.shift();
      }
    }
    type = type! ?? 'write';
    switch (type) {
      case 'read':
        return this.withReadF(...(params as any));
      case 'write':
        return this.withWriteF(...(params as any));
    }
  }

  public withReadF<T>(
    ...params: [
      ...([ctx?: Partial<ContextTimedInput>] | []),
      (lock: RWLockReader) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (lock: RWLockReader) => Promise<T>;
    return withF([this.read(...(params as any))], ([lock]) => f(lock));
  }

  public withWriteF<T>(
    ...params: [
      ...([ctx?: Partial<ContextTimedInput>] | []),
      (lock: RWLockReader) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (lock: RWLockReader) => Promise<T>;
    return withF([this.write(...(params as any))], ([lock]) => f(lock));
  }

  public withG<T, TReturn, TNext>(
    ...params: [
      ...(
        | [type?: 'read' | 'write', ctx?: Partial<ContextTimedInput>]
        | [type?: 'read' | 'write']
        | [ctx?: Partial<ContextTimedInput>]
        | []
      ),
      (lock: RWLockReader) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    let type: 'read' | 'write';
    if (params.length === 2) {
      type = params.shift() as 'read' | 'write';
    } else {
      if (typeof params[0] === 'string') {
        type = params.shift() as 'read' | 'write';
      } else if (typeof params[0] == null) {
        params.shift();
      }
    }
    type = type! ?? 'write';
    switch (type) {
      case 'read':
        return this.withReadG(...(params as any));
      case 'write':
        return this.withWriteG(...(params as any));
    }
  }

  public withReadG<T, TReturn, TNext>(
    ...params: [
      ...([ctx?: Partial<ContextTimedInput>] | []),
      (lock: RWLockReader) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      lock: RWLockReader,
    ) => AsyncGenerator<T, TReturn, TNext>;
    return withG([this.read(...(params as any))], ([lock]) => g(lock));
  }

  public withWriteG<T, TReturn, TNext>(
    ...params: [
      ...([ctx?: Partial<ContextTimedInput>] | []),
      (lock: RWLockReader) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      lock: RWLockReader,
    ) => AsyncGenerator<T, TReturn, TNext>;
    return withG([this.write(...(params as any))], ([lock]) => g(lock));
  }
}

export default RWLockReader;
