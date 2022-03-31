import type { POJO } from './types';

import { CustomError } from 'ts-custom-error';

class ErrorAsyncLocks extends CustomError {
  data: POJO;
  constructor(message: string = '', data: POJO = {}) {
    super(message);
    this.data = data;
  }
}

class ErrorAsyncLocksTimeout extends ErrorAsyncLocks {}

export { ErrorAsyncLocks, ErrorAsyncLocksTimeout };
