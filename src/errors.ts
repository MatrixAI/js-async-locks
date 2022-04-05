import { AbstractError } from '@matrixai/errors';

class ErrorAsyncLocks<T> extends AbstractError<T> {
  static description = 'Async locks error';
}

class ErrorAsyncLocksTimeout<T> extends ErrorAsyncLocks<T> {
  static description = 'Async lock timeout';
}

export { ErrorAsyncLocks, ErrorAsyncLocksTimeout };
