import { AbstractError } from '@matrixai/errors';

class ErrorAsyncLocks<T> extends AbstractError<T> {
  static description = 'Async locks error';
}

class ErrorAsyncLocksTimeout<T> extends ErrorAsyncLocks<T> {
  static description = 'Async locks timeout';
}

class ErrorAsyncLocksLockBoxConflict<T> extends ErrorAsyncLocks<T> {
  static description =
    'LockBox cannot lock same ID with different Lockable classes';
}

class ErrorAsyncLocksBarrierCount<T> extends ErrorAsyncLocks<T> {
  static description = 'Barrier must be created with a count >= 0';
}

class ErrorAsyncLocksSemaphoreLimit<T> extends ErrorAsyncLocks<T> {
  static description = 'Semaphore must be created with a limit >= 1';
}

export {
  ErrorAsyncLocks,
  ErrorAsyncLocksTimeout,
  ErrorAsyncLocksLockBoxConflict,
  ErrorAsyncLocksBarrierCount,
  ErrorAsyncLocksSemaphoreLimit,
};
