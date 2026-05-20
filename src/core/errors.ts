export type LobbysideErrorCode =
  | "QUEUE_FULL"
  | "INACTIVE"
  | "NOT_FOUND"
  | "NETWORK"
  // Thrown by the options-object form of `useLobbyside` / `useLobbysideIncomingCall`
  // when the caller passes both `widgetId` and `orgId` (or neither). Mirrors
  // the bundle's dual-attribute conflict check on the <script> tag — both
  // can't be set at once because we'd have to silently pick one and risk
  // pointing the consumer at the wrong install.
  | "INVALID_OPTIONS"
  // Org-mode only: every widget under the org is currently inactive. The
  // bundle renders nothing in this state; the SDK surfaces it as an error
  // so consumer code can `if (state.status === "error" && state.error.code
  // === "NO_LIVE_WIDGET") return null;` without re-implementing the
  // "is any widget live" check itself.
  | "NO_LIVE_WIDGET"
  // Org-mode only: two or more widgets are simultaneously live. Same
  // bundle behaviour as the 0-active case (render nothing — hosts are
  // expected to keep only one on), separate code so the consumer can
  // log/diagnose the misconfiguration.
  | "MULTIPLE_LIVE_WIDGETS";

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
