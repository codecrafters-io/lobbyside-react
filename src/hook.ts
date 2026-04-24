"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  createLobbysideClient,
  type LobbysideClient,
  type LobbysideWidgetState,
} from "./core/client";

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
 * React hook for consuming a Lobbyside widget's live state and join
 * action from inside a custom UI. See README for usage.
 *
 * The returned object is a discriminated union on `status`. Branch on
 * it; don't read fields like `hostName` without first narrowing to
 * `status === "online"`.
 */
export function useLobbyside(
  widgetId: string,
  options: UseLobbysideOptions = {},
): LobbysideWidgetState {
  // Stable per-widgetId client. If the caller flips widgetId between
  // renders (rare) we destroy the old client and spin up a new one.
  const clientRef = useRef<{ id: string; client: LobbysideClient } | null>(
    null,
  );

  useEffect(() => {
    if (clientRef.current && clientRef.current.id === widgetId) return;
    clientRef.current?.client.destroy();
    clientRef.current = {
      id: widgetId,
      client: createLobbysideClient(widgetId, { baseUrl: options.baseUrl }),
    };
    return () => {
      clientRef.current?.client.destroy();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetId, options.baseUrl]);

  return useSyncExternalStore(
    (cb) => {
      // If the client hasn't been created yet (first paint on client,
      // or during SSR), the subscribe callback is called but getState
      // returns LOADING until the effect runs. No listener churn —
      // once the client exists, we rebind via useSyncExternalStore's
      // normal path.
      return clientRef.current?.client.subscribe(cb) ?? (() => undefined);
    },
    () => clientRef.current?.client.getState() ?? LOADING,
    () => LOADING,
  );
}
