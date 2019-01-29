// @flow

// Exception for when a timeboxed promise times out
export class TimeboxTimeout {
  duration: number;

  constructor(duration: number) {
    this.duration = duration;
  }

  toString() : string {
    return `Promise did not resolve in time (timed out in ${this.duration} ms)`;
  }
}

// Wraps a promise such that if it does not resolve in `timeout` seconds,
// the promise will reject with an exception.
export function timeboxPromise<T>(
  promise: Promise<T>,
  timeout: number,
  onTimeout: ?() => void = null,
) : Promise<T> {
  if (!promise instanceof Promise) {
    throw new Error('Argument must be a promise');
  }

  return new Promise((resolve, reject) => {
    const timeoutCallback = () => {
      if (onTimeout) {
        onTimeout();
      }

      reject(new TimeboxTimeout(timeout));
    };

    const cancelTimeout = () => {
      clearTimeout(timeoutId);
    };

    const catchCallback = data => {
      clearTimeout();
      reject(data);
    };

    const timeoutId = setTimeout(timeoutCallback, timeout);

    promise.then(data => {
      cancelTimeout();
      resolve(promise);
    }).catch(catchCallback);
  });
}

export type Deferred<T> = {|
  promise: Promise<T>,
  resolve: T => void,
  reject: any => void,
|};

export function createDeferred<T>() : Deferred<T> {
  let resolve: T => void;
  let reject: any => void;

  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });

  if (!resolve || !reject) {
    throw 'error';
  }

  return { promise, resolve, reject };
}