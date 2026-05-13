"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  createLobbysideIncomingCallClient,
  type LobbysideIncomingCallClient,
  type LobbysideIncomingCallState,
  type VisitorIdentity,
} from "./core/call-client";

const IDLE: LobbysideIncomingCallState = { status: "idle" };

export interface UseLobbysideIncomingCallOptions {
  /**
   * Origin that serves the Lobbyside API. Defaults to https://lobbyside.com.
   * Override for self-hosted installs or local development.
   */
  baseUrl?: string;
  /**
   * Identity published to the host's Live tab and pre-filled into the
   * call form on accept. Equivalent to `window.Lobbyside.setVisitor`
   * in the script-tag widget. Safe to update across renders.
   */
  visitor?: VisitorIdentity;
  /**
   * Auto-decline timeout in ms. Defaults to 30000 to match the
   * script-tag widget's `RING_TIMEOUT_MS`.
   */
  ringTimeoutMs?: number;
}

/**
 * Subscribe to incoming host→visitor calls for a given widget. Returns
 * a state machine: `idle` until a host dials this tab, then `ringing`
 * with `accept`/`decline` handlers.
 *
 * Mount this hook anywhere on your page to make a visitor reachable —
 * it publishes presence + opens the invite room. Pair it with
 * `useLobbyside` if you also want to render the Join 1:1 CTA; they
 * share the InstantDB connection.
 *
 * CRITICAL: call `accept()` and then `window.open(callUrl, "_blank")`
 * synchronously inside the click handler. Any await/Promise between
 * the user gesture and the popup call trips iOS Safari's popup blocker.
 *
 * @example
 *   const incoming = useLobbysideIncomingCall(widgetId, {
 *     visitor: { name: "Ada", email: "ada@example.com" },
 *   });
 *   if (incoming.status === "ringing") {
 *     return (
 *       <button onClick={() => {
 *         const { callUrl } = incoming.call.accept();
 *         window.open(callUrl, "_blank");
 *       }}>Accept</button>
 *     );
 *   }
 */
export function useLobbysideIncomingCall(
  widgetId: string,
  options: UseLobbysideIncomingCallOptions = {},
): LobbysideIncomingCallState {
  const clientRef = useRef<{
    id: string;
    baseUrl: string | undefined;
    ringTimeoutMs: number | undefined;
    client: LobbysideIncomingCallClient;
  } | null>(null);

  useEffect(() => {
    const cur = clientRef.current;
    const same =
      cur &&
      cur.id === widgetId &&
      cur.baseUrl === options.baseUrl &&
      cur.ringTimeoutMs === options.ringTimeoutMs;
    if (same) return;
    cur?.client.destroy();
    clientRef.current = {
      id: widgetId,
      baseUrl: options.baseUrl,
      ringTimeoutMs: options.ringTimeoutMs,
      client: createLobbysideIncomingCallClient(widgetId, {
        baseUrl: options.baseUrl,
        visitor: options.visitor,
        ringTimeoutMs: options.ringTimeoutMs,
      }),
    };
    return () => {
      clientRef.current?.client.destroy();
      clientRef.current = null;
    };
    // visitor handled separately so its mutation doesn't recreate the client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetId, options.baseUrl, options.ringTimeoutMs]);

  // Diff the visitor by stringified value — inline `visitor={{...}}` would
  // otherwise emit a fresh reference each render and spam presence updates.
  const visitorKey = useMemo(
    () => (options.visitor ? JSON.stringify(options.visitor) : ""),
    [options.visitor],
  );
  useEffect(() => {
    clientRef.current?.client.setVisitor(options.visitor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitorKey]);

  return useSyncExternalStore(
    (cb) => clientRef.current?.client.subscribe(cb) ?? (() => undefined),
    () => clientRef.current?.client.getState() ?? IDLE,
    () => IDLE,
  );
}
