import type { ResourceRelease } from '@matrixai/resources';
import type {
  ResourceAcquireCancellable,
  Lockable,
  ContextTimed,
  ContextTimedInput,
} from './types';
import { withF, withG } from '@matrixai/resources';
import { PromiseCancellable } from '@matrixai/async-cancellable';
import Lock from './Lock';
import * as utils from './utils';
import * as errors from './errors';

/**
 * Write-preferring read write lock
 */
class RWLockWriter implements Lockable {
  protected readersLock: Lock = new Lock();
  protected writersLock: Lock = new Lock();
  protected readersRelease: ResourceRelease;
  protected readerCountBlocked: number = 0;
  protected acquireReadersLockP: PromiseCancellable<
    readonly [ResourceRelease, Lock?]
  >;
  protected _readerCount: number = 0;
  protected _writerCount: number = 0;

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
      return this._writerCount === 0 && this.readersLock.isLocked();
    } else if (type === 'write') {
      return this.writersLock.isLocked();
    } else {
      return this.readersLock.isLocked() || this.writersLock.isLocked();
    }
  }

  public lock(
    ...params:
      | [type?: 'read' | 'write', ctx?: Partial<ContextTimedInput>]
      | [type?: 'read' | 'write']
      | [ctx?: Partial<ContextTimedInput>]
      | []
  ): ResourceAcquireCancellable<RWLockWriter> {
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
  ): ResourceAcquireCancellable<RWLockWriter> {
    ctx = ctx != null ? { ...ctx } : {};
    return () => {
      return utils.setupTimedCancellable(
        async (ctx: ContextTimed) => {
          if (this._writerCount > 0) {
            ++this.readerCountBlocked;
            const waitWritersLockP = this.writersLock.waitForUnlock(ctx);
            try {
              await waitWritersLockP;
            } finally {
              --this.readerCountBlocked;
            }
          }
          const readerCount = ++this._readerCount;
          // The first reader locks
          if (readerCount === 1) {
            const acquireReadersLock = this.readersLock.lock(ctx);
            this.acquireReadersLockP = acquireReadersLock();
            try {
              [this.readersRelease] = await this.acquireReadersLockP;
            } catch (e) {
              --this._readerCount;
              throw e;
            }
          } else {
            // Without this, the second or later reader will always lock faster
            // than the first reader. This forces the subsequent readers to always
            // wait for the first reader to settle, while discarding any errors.
            await this.acquireReadersLockP.catch(() => {});
          }
          let released = false;
          return [
            async () => {
              if (released) return;
              released = true;
              const readerCount = --this._readerCount;
              // The last reader unlocks
              if (readerCount === 0) {
                await this.readersRelease();
              }
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
  ): ResourceAcquireCancellable<RWLockWriter> {
    ctx = ctx != null ? { ...ctx } : {};
    return () => {
      return utils.setupTimedCancellable(
        async (ctx: ContextTimed) => {
          ++this._writerCount;
          const acquireWritersLock = this.writersLock.lock(ctx);
          const acquireWritersLockP = acquireWritersLock();
          let writersRelease: ResourceRelease;
          try {
            [writersRelease] = await acquireWritersLockP;
          } catch (e) {
            --this._writerCount;
            throw e;
          }
          const acquireReadersLock = this.readersLock.lock(ctx);
          const acquireReadersLockP = acquireReadersLock();
          try {
            [this.readersRelease] = await acquireReadersLockP;
          } catch (e) {
            await writersRelease();
            --this._writerCount;
            throw e;
          }
          let released = false;
          return [
            async () => {
              if (released) return;
              released = true;
              await this.readersRelease();
              await writersRelease();
              --this._writerCount;
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
      (lock: RWLockWriter) => Promise<T>,
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
      (lock: RWLockWriter) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (lock: RWLockWriter) => Promise<T>;
    return withF([this.read(...(params as any))], ([lock]) => f(lock));
  }

  public withWriteF<T>(
    ...params: [
      ...([ctx?: Partial<ContextTimedInput>] | []),
      (lock: RWLockWriter) => Promise<T>,
    ]
  ): Promise<T> {
    const f = params.pop() as (lock: RWLockWriter) => Promise<T>;
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
      (lock: RWLockWriter) => AsyncGenerator<T, TReturn, TNext>,
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
      (lock: RWLockWriter) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      lock: RWLockWriter,
    ) => AsyncGenerator<T, TReturn, TNext>;
    return withG([this.read(...(params as any))], ([lock]) => g(lock));
  }

  public withWriteG<T, TReturn, TNext>(
    ...params: [
      ...([ctx?: Partial<ContextTimedInput>] | []),
      (lock: RWLockWriter) => AsyncGenerator<T, TReturn, TNext>,
    ]
  ): AsyncGenerator<T, TReturn, TNext> {
    const g = params.pop() as (
      lock: RWLockWriter,
    ) => AsyncGenerator<T, TReturn, TNext>;
    return withG([this.write(...(params as any))], ([lock]) => g(lock));
  }
}

export default RWLockWriter;
