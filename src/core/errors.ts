export type LobbysideErrorCode =
  | "QUEUE_FULL"
  | "INACTIVE"
  | "NOT_FOUND"
  | "NETWORK";

/**
 * Errors thrown by the Lobbyside SDK.
 *
 * `code` is the stable programmatic handle; branch on it in consumer
 * catch blocks. `message` is a human-readable fallback for unexpected
 * branches, not a stable UI string.
 */
export class LobbysideError extends Error {
  readonly code: LobbysideErrorCode;

  constructor(code: LobbysideErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "LobbysideError";
    // Preserve the prototype when transpiled down through ES5 target
    // so `instanceof LobbysideError` holds for consumers on older
    // TypeScript toolchains.
    Object.setPrototypeOf(this, LobbysideError.prototype);
  }
}
