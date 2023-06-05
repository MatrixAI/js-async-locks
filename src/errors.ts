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

/**
 * If you get this exception, this means within the same `Monitor` instance,
 * you tried to lock a read on a key that is already locked for write, or
 * you tried to lock a write on a key that is already locked for read. This
 * is not supported because to do so would imply a lock upgrade from read to
 * write or from write to read.
 */
class ErrorAsyncLocksMonitorLockType<T> extends ErrorAsyncLocks<T> {
  static description =
    'Monitor does not support upgrading or downgrading the lock type';
}

class ErrorAsyncLocksMonitorDeadlock<T> extends ErrorAsyncLocks<T> {
  static description = 'Monitor has met a potential deadlock';
}

export {
  ErrorAsyncLocks,
  ErrorAsyncLocksTimeout,
  ErrorAsyncLocksLockBoxConflict,
  ErrorAsyncLocksMonitorLockType,
  ErrorAsyncLocksMonitorDeadlock,
};
