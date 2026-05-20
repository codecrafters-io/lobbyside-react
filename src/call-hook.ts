"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  createLobbysideIncomingCallClient,
  createLobbysideOrgIncomingCallClient,
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
 * Options-object form of {@link useLobbysideIncomingCall}. Supplies *one*
 * of `widgetId` or `orgId`; passing both logs a `console.error` and
 * keeps the hook in `idle` (matches the script-tag install's dual-attr
 * rule).
 */
export interface UseLobbysideIncomingCallArgs
  extends UseLobbysideIncomingCallOptions {
  widgetId?: string;
  orgId?: string;
}

type Mode = "widget" | "org" | "idle";

interface NormalizedArgs {
  mode: Mode;
  widgetId?: string;
  orgId?: string;
  baseUrl?: string;
  visitor?: VisitorIdentity;
  ringTimeoutMs?: number;
}

function normalizeArgs(
  arg1: string | UseLobbysideIncomingCallArgs,
  options: UseLobbysideIncomingCallOptions,
): NormalizedArgs {
  if (typeof arg1 === "string") {
    return {
      mode: "widget",
      widgetId: arg1,
      baseUrl: options.baseUrl,
      visitor: options.visitor,
      ringTimeoutMs: options.ringTimeoutMs,
    };
  }
  const { widgetId, orgId, baseUrl, visitor, ringTimeoutMs } = arg1;
  if (widgetId && orgId) {
    console.error(
      `[Lobbyside] useLobbysideIncomingCall: pass either { widgetId } or { orgId }, not both. widgetId="${widgetId}", orgId="${orgId}".`,
    );
    return { mode: "idle" };
  }
  if (widgetId) {
    return { mode: "widget", widgetId, baseUrl, visitor, ringTimeoutMs };
  }
  if (orgId) {
    return { mode: "org", orgId, baseUrl, visitor, ringTimeoutMs };
  }
  return { mode: "idle" };
}

interface ClientRef {
  mode: "widget" | "org";
  key: string;
  client: LobbysideIncomingCallClient;
}

/**
 * Subscribe to incoming host→visitor calls. Returns a state machine:
 * `idle` until a host dials this tab, then `ringing` with
 * `accept`/`decline` handlers.
 *
 * Two call shapes:
 *
 * - `useLobbysideIncomingCall("widget-uuid", options?)` — legacy positional form.
 * - `useLobbysideIncomingCall({ widgetId | orgId, ...options })` — pick
 *   at runtime; passing both ids stays idle and logs an error.
 *
 * In **org mode** the visitor is reachable by whichever widget in the
 * org is currently switched on. When the host toggles which widget is
 * live, the SDK rebinds presence rooms to the new active widget; an
 * in-flight ring is declined with reason `widget_swapped`.
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
 *   const incoming = useLobbysideIncomingCall({ widgetId, visitor: {...} });
 *   // org-wide install:
 *   const incoming = useLobbysideIncomingCall({ orgId, visitor: {...} });
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
  options?: UseLobbysideIncomingCallOptions,
): LobbysideIncomingCallState;
export function useLobbysideIncomingCall(
  args: UseLobbysideIncomingCallArgs,
): LobbysideIncomingCallState;
export function useLobbysideIncomingCall(
  arg1: string | UseLobbysideIncomingCallArgs,
  options: UseLobbysideIncomingCallOptions = {},
): LobbysideIncomingCallState {
  const normalized = normalizeArgs(arg1, options);

  // Visitor lives outside the cacheKey so its mutation propagates via
  // setVisitor on the same client (no churn). baseUrl + ringTimeoutMs
  // ARE part of the key because they affect client construction.
  const cacheKey =
    normalized.mode === "idle"
      ? "idle"
      : `${normalized.mode}:${
          normalized.widgetId ?? normalized.orgId ?? ""
        }:${normalized.baseUrl ?? ""}:${normalized.ringTimeoutMs ?? ""}`;

  const clientRef = useRef<ClientRef | null>(null);

  useEffect(() => {
    if (normalized.mode === "idle") {
      clientRef.current?.client.destroy();
      clientRef.current = null;
      return;
    }
    if (clientRef.current && clientRef.current.key === cacheKey) return;
    clientRef.current?.client.destroy();
    if (normalized.mode === "widget" && normalized.widgetId) {
      clientRef.current = {
        mode: "widget",
        key: cacheKey,
        client: createLobbysideIncomingCallClient(normalized.widgetId, {
          baseUrl: normalized.baseUrl,
          visitor: normalized.visitor,
          ringTimeoutMs: normalized.ringTimeoutMs,
        }),
      };
    } else if (normalized.mode === "org" && normalized.orgId) {
      clientRef.current = {
        mode: "org",
        key: cacheKey,
        client: createLobbysideOrgIncomingCallClient(normalized.orgId, {
          baseUrl: normalized.baseUrl,
          visitor: normalized.visitor,
          ringTimeoutMs: normalized.ringTimeoutMs,
        }),
      };
    }
    return () => {
      clientRef.current?.client.destroy();
      clientRef.current = null;
    };
    // visitor intentionally not in deps; setVisitor diff below handles it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  // Diff the visitor by stringified value — inline `visitor={{...}}` would
  // otherwise emit a fresh reference each render and spam presence updates.
  const visitorKey = useMemo(
    () => (normalized.visitor ? JSON.stringify(normalized.visitor) : ""),
    [normalized.visitor],
  );
  useEffect(() => {
    clientRef.current?.client.setVisitor(normalized.visitor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitorKey]);

  return useSyncExternalStore(
    (cb: () => void) => {
      if (normalized.mode === "idle") return () => undefined;
      return clientRef.current?.client.subscribe(cb) ?? (() => undefined);
    },
    () => {
      if (normalized.mode === "idle") return IDLE;
      return clientRef.current?.client.getState() ?? IDLE;
    },
    () => IDLE,
  );
}
