import {
  init,
  type InstantCoreDatabase,
  type InstantUnknownSchema,
} from "@instantdb/core";

/**
 * Queue entry shape used to count `status === "queued"` entries. This
 * is a loose subset of the server schema — InstantDB returns extra
 * fields we ignore.
 */
interface QueueEntryRow {
  status?: string;
}

/**
 * Widget config shape as returned by the InstantDB subscription (not
 * the HTTP endpoint — though the fields overlap). Every field is
 * optional here because InstantDB emits partial data during hydration
 * and the hook merges it on top of the HTTP-fetched initial snapshot.
 */
export interface SubscribedWidgetConfig {
  isActive?: boolean;
  meetLink?: string;
  hostName?: string;
  hostTitle?: string;
  avatarUrl?: string;
  ctaText?: string;
  buttonText?: string;
  theme?: string;
  customBgColor?: string | null;
  customAccentColor?: string | null;
  boldFont?: string | null;
  maxQueueSize?: number;
}

export interface SubscribedWidget {
  slug?: string;
  widgetConfig?: SubscribedWidgetConfig | SubscribedWidgetConfig[];
  queueEntries?: QueueEntryRow[];
}

/**
 * Singleton InstantDB client per app ID. Multiple useLobbyside calls
 * with the same widgetId on the same page share one connection —
 * InstantDB fans out subscriptions internally over a single WebSocket.
 *
 * NOTE: The plan specifies `InstantCoreDatabase<never>` but `never`
 * does not satisfy the `InstantSchemaDef<any, any, any>` constraint.
 * The correct no-schema type exported by `@instantdb/core` is
 * `InstantUnknownSchema` (= `InstantUnknownSchemaDef`).
 */
const clients = new Map<string, InstantCoreDatabase<InstantUnknownSchema>>();

export function getInstantClient(
  appId: string,
): InstantCoreDatabase<InstantUnknownSchema> {
  const existing = clients.get(appId);
  if (existing) return existing;
  const db = init({ appId });
  clients.set(appId, db);
  return db;
}

/**
 * Subscribe to a single widget's config + related queue entries.
 * Returns an unsubscribe function. All subscription work flows through
 * `ruleParams: { companyId }` to satisfy the server's permission rules,
 * matching what `public/widget.js` already does.
 */
export function subscribeToWidget(
  db: InstantCoreDatabase<InstantUnknownSchema>,
  widgetId: string,
  onUpdate: (widget: SubscribedWidget | undefined) => void,
): () => void {
  return db.subscribeQuery(
    {
      widgets: {
        $: { where: { id: widgetId } },
        widgetConfig: {},
        queueEntries: {},
      },
    },
    (resp) => {
      if (!resp.data) return;
      const widgets = (resp.data as { widgets?: SubscribedWidget[] }).widgets;
      onUpdate(widgets?.[0]);
    },
    { ruleParams: { companyId: widgetId } },
  );
}

export function normalizeConfig(
  raw: SubscribedWidgetConfig | SubscribedWidgetConfig[] | undefined,
): SubscribedWidgetConfig | undefined {
  if (!raw) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

export function countQueued(entries: QueueEntryRow[] | undefined): number {
  if (!entries) return 0;
  return entries.filter((e) => e.status === "queued").length;
}
