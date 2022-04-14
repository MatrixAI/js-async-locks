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

export {
  ErrorAsyncLocks,
  ErrorAsyncLocksTimeout,
  ErrorAsyncLocksLockBoxConflict,
};
