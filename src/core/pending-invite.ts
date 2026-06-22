import type { IncomingInvitePayload } from "./call-client";

/**
 * Recovers a ring lost to a mid-ring page refresh. The live invite is a
 * fire-and-forget InstantDB room topic, gone by the time a reload
 * re-subscribes — so reconcile against the persistent ringing call row,
 * keyed on the sessionStorage-stable tabId. Mirrors the script-tag bundle's
 * `fetchPendingInvite` (src/widget/_init/pending-invite.ts).
 */
export async function fetchPendingInvite(
  baseUrl: string,
  widgetId: string,
  tabId: string,
): Promise<IncomingInvitePayload | null> {
  if (typeof fetch !== "function") return null;
  try {
    const res = await fetch(
      `${baseUrl}/api/widget/${encodeURIComponent(
        widgetId,
      )}/pending-invite/${encodeURIComponent(tabId)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { invite?: unknown };
    const invite = data?.invite;
    if (!invite || typeof invite !== "object") return null;
    const v = invite as Record<string, unknown>;
    if (typeof v.callId !== "string" || typeof v.slug !== "string") return null;
    return invite as IncomingInvitePayload;
  } catch {
    return null;
  }
}
