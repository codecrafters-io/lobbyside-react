import { LobbysideError } from "./errors";

/**
 * Shape of a successful GET /api/widget/{id}/config response.
 *
 * Mirrors the server handler at:
 *   src/app/api/widget/[companyId]/config/route.ts
 *
 * Fields under `displayData` are a superset of what the hook surfaces
 * publicly — the full shape is preserved for forward compatibility
 * with new fields.
 */
export interface WidgetConfigResponse {
  active: boolean;
  instantAppId: string;
  displayData: {
    hostName: string;
    hostTitle: string;
    avatarUrl: string;
    ctaText: string;
    buttonText: string;
    meetLink: string;
    slug: string;
    widgetName?: string;
    theme?: string;
    customBgColor?: string | null;
    customAccentColor?: string | null;
    postCallBehavior?: string;
    postCallCooldownSeconds?: number;
    formNameMode?: string;
    formCompanyMode?: string;
    formEmailMode?: string;
    formEmailVerification?: boolean;
    formLinkedinMode?: string;
    formGithubMode?: string;
    boldFont?: string | null;
    maxQueueSize?: number;
  };
}

/**
 * Fetch the initial widget config. Resolves on 2xx, throws LobbysideError
 * on every other path. Used once on mount to drive first-paint; subsequent
 * state changes arrive via InstantDB.
 */
export async function fetchWidgetConfig(
  widgetId: string,
  baseUrl: string,
): Promise<WidgetConfigResponse> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/widget/${widgetId}/config`, {
      method: "GET",
    });
  } catch (err) {
    throw new LobbysideError(
      "NETWORK",
      `Failed to reach Lobbyside: ${(err as Error).message}`,
    );
  }

  if (res.status === 404) {
    throw new LobbysideError(
      "NOT_FOUND",
      `Widget ${widgetId} not found at ${baseUrl}.`,
    );
  }

  if (!res.ok) {
    throw new LobbysideError(
      "NETWORK",
      `Config request failed with HTTP ${res.status}.`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new LobbysideError("NETWORK", "Config response was not valid JSON.");
  }

  const parsed = body as WidgetConfigResponse;
  if (typeof parsed.instantAppId !== "string" || parsed.instantAppId === "") {
    // Defensive — server-side contract guarantees this, but if a
    // customer proxies the endpoint through their own infra and strips
    // the field, we want a crisp error rather than a mysterious
    // InstantDB failure three calls downstream.
    throw new LobbysideError(
      "NETWORK",
      "Config response missing instantAppId.",
    );
  }

  return parsed;
}
