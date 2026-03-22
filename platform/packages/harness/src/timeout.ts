export class HandlerTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Handler timed out after ${timeoutMs}ms`);
    this.name = "HandlerTimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HandlerTimeoutError(timeoutMs));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
