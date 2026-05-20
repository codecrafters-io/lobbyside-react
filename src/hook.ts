"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  createLobbysideClient,
  createLobbysideOrgClient,
  type LobbysideClient,
  type LobbysideWidgetState,
} from "./core/client";
import { LobbysideError } from "./core/errors";

const LOADING: LobbysideWidgetState = { status: "loading" };

export interface UseLobbysideOptions {
  /**
   * Origin that serves the Lobbyside API. Defaults to the production
   * deployment at https://lobbyside.com. Override for self-hosted
   * installs or local development.
   */
  baseUrl?: string;
}

/**
 * Options-object form of {@link useLobbyside}. Supplies *one* of
 * `widgetId` or `orgId`; passing both errors loudly (the same rule the
 * `<script data-widget-id ... data-org-id>` install enforces — we
 * refuse to silently pick one and point at the wrong embed).
 */
export interface UseLobbysideArgs {
  widgetId?: string;
  orgId?: string;
  baseUrl?: string;
}

// Static error states kept at module scope so `useSyncExternalStore`'s
// server snapshot stays referentially stable across rerenders (otherwise
// React triggers a "result changed during getServerSnapshot" warning in
// strict mode).
const ERROR_BOTH_IDS: LobbysideWidgetState = {
  status: "error",
  error: new LobbysideError(
    "INVALID_OPTIONS",
    "useLobbyside: pass either { widgetId } or { orgId }, not both.",
  ),
};

const ERROR_NO_IDS: LobbysideWidgetState = {
  status: "error",
  error: new LobbysideError(
    "INVALID_OPTIONS",
    "useLobbyside: { widgetId } or { orgId } is required.",
  ),
};

type Mode = "widget" | "org" | "error";

interface NormalizedArgs {
  mode: Mode;
  widgetId?: string;
  orgId?: string;
  baseUrl?: string;
  errorState?: LobbysideWidgetState;
}

function normalizeArgs(
  arg1: string | UseLobbysideArgs,
  options: UseLobbysideOptions,
): NormalizedArgs {
  if (typeof arg1 === "string") {
    return { mode: "widget", widgetId: arg1, baseUrl: options.baseUrl };
  }
  const { widgetId, orgId, baseUrl } = arg1;
  if (widgetId && orgId) {
    // Loud signal so the developer notices in their dev console; the
    // returned state lets a runtime branch (`status === "error"`) also
    // handle it gracefully without crashing the consumer's app.
    console.error(
      `[Lobbyside] useLobbyside: pass either { widgetId } or { orgId }, not both. widgetId="${widgetId}", orgId="${orgId}".`,
    );
    return { mode: "error", errorState: ERROR_BOTH_IDS };
  }
  if (widgetId) return { mode: "widget", widgetId, baseUrl };
  if (orgId) return { mode: "org", orgId, baseUrl };
  return { mode: "error", errorState: ERROR_NO_IDS };
}

interface ClientRef {
  mode: "widget" | "org";
  key: string;
  client: LobbysideClient;
}

/**
 * React hook for consuming a Lobbyside install's live state and join
 * action from inside a custom UI. See README for usage.
 *
 * Two call shapes:
 *
 * - `useLobbyside("widget-uuid")` — single widget, legacy positional form.
 * - `useLobbyside({ widgetId | orgId, baseUrl? })` — pick at runtime;
 *   passing both ids errors (matches the script-tag install rule).
 *
 * Org mode renders whichever widget in the org is currently switched on
 * (`status: "online"`) and surfaces an error with code `NO_LIVE_WIDGET`
 * or `MULTIPLE_LIVE_WIDGETS` for the 0-active / >1-active safety-net
 * cases — same render-nothing behaviour as the bundle.
 *
 * The returned object is a discriminated union on `status`. Branch on
 * it; don't read fields like `hostName` without first narrowing.
 */
export function useLobbyside(
  widgetId: string,
  options?: UseLobbysideOptions,
): LobbysideWidgetState;
export function useLobbyside(args: UseLobbysideArgs): LobbysideWidgetState;
export function useLobbyside(
  arg1: string | UseLobbysideArgs,
  options: UseLobbysideOptions = {},
): LobbysideWidgetState {
  const normalized = normalizeArgs(arg1, options);
  // Collapse (mode, id, baseUrl) into a single string key so we can
  // detect when the consumer switched between widget/org modes or
  // between ids. The effect uses this as its only dep; everything else
  // is captured through it.
  const cacheKey =
    normalized.mode === "error"
      ? `error:${normalized.errorState === ERROR_BOTH_IDS ? "both" : "missing"}`
      : `${normalized.mode}:${
          normalized.widgetId ?? normalized.orgId ?? ""
        }:${normalized.baseUrl ?? ""}`;

  const clientRef = useRef<ClientRef | null>(null);

  useEffect(() => {
    if (normalized.mode === "error") {
      // A switch from a valid id to a misconfigured options object
      // should tear the live subscription down.
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
        client: createLobbysideClient(normalized.widgetId, {
          baseUrl: normalized.baseUrl,
        }),
      };
    } else if (normalized.mode === "org" && normalized.orgId) {
      clientRef.current = {
        mode: "org",
        key: cacheKey,
        client: createLobbysideOrgClient(normalized.orgId, {
          baseUrl: normalized.baseUrl,
        }),
      };
    }
    return () => {
      clientRef.current?.client.destroy();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  return useSyncExternalStore(
    // Explicit `cb: () => void` annotation matches LobbysideClient's
    // subscribe signature so the file typechecks without relying on
    // useSyncExternalStore's inference — useful when the IDE's TS server
    // indexes this package before its node_modules exists.
    (cb: () => void) => {
      if (normalized.mode === "error") return () => undefined;
      return clientRef.current?.client.subscribe(cb) ?? (() => undefined);
    },
    () => {
      if (normalized.mode === "error") return normalized.errorState!;
      return clientRef.current?.client.getState() ?? LOADING;
    },
    () => {
      if (normalized.mode === "error") return normalized.errorState!;
      return LOADING;
    },
  );
}
