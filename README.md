# @lobbyside/react

Render your own custom widget UI against a live [Lobbyside](https://lobbyside.com) install. Two hooks:

- `useLobbyside` — host identity, online/offline + queue state, and a `joinCall` action for the "Join 1:1" CTA.
- `useLobbysideIncomingCall` — make a visitor reachable from the host's Live tab; ring on incoming calls and offer `accept` / `decline`.

Both hooks accept either a single widget id (the legacy positional form) **or** an options object with `{ widgetId | orgId }` — the org form picks whichever widget in the org the host has currently switched on. See [Org-wide installs](#org-wide-installs) below.

If you just want a drop-in widget with our default look, use the script-tag install instead.

## Install

    npm install @lobbyside/react

Peer dependencies: `react >= 18` and `@instantdb/core >= 1.0`.

## Usage

```tsx
import { useLobbyside } from '@lobbyside/react';

export function MyCTA() {
  const widget = useLobbyside('YOUR_WIDGET_ID');

  if (widget.status === 'loading' || widget.status === 'error') return null;

  return (
    <div>
      <img src={widget.avatarUrl} alt={widget.hostName} />
      <h3>{widget.hostName}</h3>
      <p>{widget.hostTitle}</p>
      {widget.status === 'online' ? (
        <button
          disabled={widget.isQueueFull}
          onClick={async () => {
            try {
              const { entryUrl } = await widget.joinCall();
              window.open(entryUrl, '_blank');
            } catch (err) {
              if (err.code === 'QUEUE_FULL') alert('Queue is full');
            }
          }}
        >
          {widget.isQueueFull ? 'Queue is full' : widget.buttonText}
        </button>
      ) : widget.offlineCtaUrl ? (
        <a href={widget.offlineCtaUrl} target="_blank" rel="noreferrer">
          {widget.offlineButtonText || 'Book a time'}
        </a>
      ) : (
        <p>Currently offline. Check back later.</p>
      )}
    </div>
  );
}
```

## Return value

`useLobbyside` returns one of five states:

- `{ status: 'loading' }` — initial render, before the first HTTP fetch resolves.
- `{ status: 'error', error: LobbysideError }` — the widget ID doesn't exist (`NOT_FOUND`) or the request failed (`NETWORK`).
- `{ status: 'hidden' }` — the host's active targeting cohort excludes this visitor (see [Targeting](#targeting-cohorts)). Render nothing — same outcome as the script-tag embed. No identity is surfaced.
- `{ status: 'offline', ...identity }` — the host has the widget toggled off. Identity fields are still available so you can render "Sarup is offline" with the avatar and host name intact.
- `{ status: 'online', ...identity, isQueueFull, joinCall }` — live.

### Identity fields (available on both `offline` and `online`)

| Field | Type | Notes |
|---|---|---|
| `hostName` | `string` | |
| `hostTitle` | `string` | |
| `avatarUrl` | `string` | Empty string if the host hasn't set one. |
| `ctaText` | `string` | |
| `buttonText` | `string` | |

### Online-only fields

| Field | Type | Notes |
|---|---|---|
| `isQueueFull` | `boolean` | Live — flips to `true` when the configured queue size is reached. |
| `joinCall(args?)` | `() => Promise<{ entryUrl: string }>` | POSTs to Lobbyside. Open `entryUrl` in a new tab on success. |

### Offline-only fields

When the host has the widget paused, you'll get a backup link (e.g. Cal.com / Calendly) the visitor can click instead of waiting in queue. All three are `""` when the host hasn't configured them — branch on `offlineCtaUrl` to decide whether to render a button at all.

| Field | Type | Notes |
|---|---|---|
| `offlineCtaUrl` | `string` | Booking link to open. Empty string when the host left it blank — render nothing. |
| `offlineCtaText` | `string` | Optional message shown above the booking button (e.g. "Out fishing, back tomorrow."). |
| `offlineButtonText` | `string` | Optional button label. Falls back to your own copy when empty. |

```tsx
if (widget.status === 'offline') {
  if (!widget.offlineCtaUrl) {
    return <p>{widget.hostName} is currently offline. Check back later.</p>;
  }
  return (
    <div>
      <p>{widget.offlineCtaText || `${widget.hostName} is offline.`}</p>
      <a href={widget.offlineCtaUrl} target="_blank" rel="noreferrer">
        {widget.offlineButtonText || 'Book a time'}
      </a>
    </div>
  );
}
```

### Passing visitor data

```tsx
await widget.joinCall({
  visitor: { name: 'Ada', email: 'ada@example.com' },
});
```

Keys recognized by the server today: `name`, `email`, `company`, `github`. Whatever you pass pre-fills the corresponding fields on the visitor form at `entryUrl`.


## Targeting (cohorts)

If the host configures a targeting cohort in the Lobbyside dashboard — show only to certain countries, only after N seconds on the page, or only on certain URLs — the SDK honors it exactly like the script-tag embed. When the visitor doesn't match the active cohort, the hook returns `{ status: 'hidden' }` and you render nothing:

```tsx
const widget = useLobbyside('YOUR_WIDGET_ID');
if (widget.status === 'loading' || widget.status === 'hidden') return null;
```

The match is re-evaluated live: it tracks SPA navigation (so a path-scoped cohort appears/disappears as the visitor moves around), and a session-minimum cohort flips `hidden → online` on its own once enough time has elapsed — no extra wiring on your side. Targeting takes precedence over `offline`, so an excluded visitor sees nothing even when the host is paused. Geo is resolved server-side from the visitor's request; no cohort = shown to everyone (the hook never returns `hidden`). Works in both widget-id and `orgId` modes.

## Errors

`joinCall` throws `LobbysideError`. The `error` field on the hook's `status: 'error'` state is the same type. Branch on `err.code`:

- `QUEUE_FULL` — thrown client-side when `isQueueFull === true`, or server-side if the queue filled between render and click.
- `INACTIVE` — the widget was toggled off mid-click.
- `NOT_FOUND` — the widget / org ID doesn't exist.
- `NETWORK` — anything else (fetch rejection, unexpected HTTP status, malformed JSON).
- `INVALID_OPTIONS` — you passed both `widgetId` and `orgId` (or neither) to the options-object form. See [Org-wide installs](#org-wide-installs).
- `NO_LIVE_WIDGET` — org mode only. Zero widgets in the org are currently live; the script-tag bundle would render nothing in this state.
- `MULTIPLE_LIVE_WIDGETS` — org mode only. Two or more widgets in the org are live simultaneously (safety net — hosts are expected to keep one on).

## Org-wide installs

Pass `{ orgId }` instead of `{ widgetId }` to either hook and the SDK picks whichever widget in the org the host has currently switched on. Matches the `<script data-org-id="...">` install: one mount covers every widget in the org, and flipping which one is live in the dashboard takes effect immediately without a code change.

```tsx
import { useLobbyside, useLobbysideIncomingCall } from '@lobbyside/react';

export function OrgWidget() {
  const widget = useLobbyside({ orgId: 'YOUR_ORG_ID' });
  const incoming = useLobbysideIncomingCall({
    orgId: 'YOUR_ORG_ID',
    visitor: { name: 'Ada', email: 'ada@example.com' },
  });

  if (incoming.status === 'ringing') {
    return (
      <button
        onClick={() => {
          const { callUrl } = incoming.call.accept();
          window.open(callUrl, '_blank');
        }}
      >
        Answer {incoming.call.hostName}
      </button>
    );
  }

  if (widget.status === 'loading') return null;

  // 0 or >1 widgets live in the org surface as error states. The bundle
  // renders nothing in both cases — match that, or render a hint while
  // the dashboard catches up.
  if (widget.status === 'error') {
    if (widget.error.code === 'NO_LIVE_WIDGET') return null;
    if (widget.error.code === 'MULTIPLE_LIVE_WIDGETS') return null;
    return null;
  }

  if (widget.status !== 'online') return null;
  return (
    <button
      disabled={widget.isQueueFull}
      onClick={async () => {
        const { entryUrl } = await widget.joinCall();
        window.open(entryUrl, '_blank');
      }}
    >
      {widget.isQueueFull ? 'Queue is full' : widget.buttonText}
    </button>
  );
}
```

### How `useLobbyside` handles org state

| Active widgets in the org | `status` | Notes |
|---|---|---|
| 0 | `error`, `code: 'NO_LIVE_WIDGET'` | No host is live. |
| 1 | `online` | Identity + `isQueueFull` + `joinCall` come from that widget. Flipping which widget is on swaps these live; no remount needed. |
| 2+ | `error`, `code: 'MULTIPLE_LIVE_WIDGETS'` | Safety net while the host toggles. Clears as soon as exactly one stays on. |

`offline` is not used in org mode — a widget that's switched off isn't surfaced as an identity-carrying offline state, because in org mode there's no single widget identity to attach to. If you need an offline fallback per widget, use the widget-id form.

### How `useLobbysideIncomingCall` handles org state

Same hook, same `idle` / `ringing` state machine. The difference is what's happening under the hood:

- When the host toggles which widget is live, the SDK rebinds the visitor's per-tab presence rooms to that widget. The host of the *currently active* widget sees this tab in their Live table; previously-active hosts no longer do.
- If the active widget changes mid-ring, the in-flight invite is declined with `reason: "widget_swapped"` (matches the script-tag bundle's org-mode teardown).
- When 0 or >1 widgets are live the visitor is unreachable — `status` stays `idle` and any invite is ignored.

### Validation: don't pass both ids

Passing both `widgetId` and `orgId` to either hook logs a `console.error` and:

- `useLobbyside` returns `{ status: 'error', error: { code: 'INVALID_OPTIONS', ... } }`.
- `useLobbysideIncomingCall` stays `idle`.

This mirrors the script-tag install's dual-attribute rule: silently picking one would risk pointing at the wrong embed.

```tsx
// Don't do this. It errors loudly.
useLobbyside({ widgetId: 'w-1', orgId: 'org-1' });
```

## Incoming calls (`useLobbysideIncomingCall`)

Lets a visitor receive calls dialled from the host's Live tab — the inbound side of the queue. Mount the hook anywhere on the visitor-facing page; it publishes presence + opens the invite room. When the host rings, the state flips to `ringing` and you render Accept/Decline however you like.

```tsx
import { useLobbysideIncomingCall } from '@lobbyside/react';

export function CallBanner() {
  const incoming = useLobbysideIncomingCall('YOUR_WIDGET_ID', {
    visitor: { name: 'Ada Lovelace', email: 'ada@example.com' },
  });

  if (incoming.status !== 'ringing') return null;

  return (
    <div role="dialog" aria-label="Incoming call">
      <p><strong>{incoming.call.hostName}</strong> is calling</p>
      <button
        onClick={() => {
          // Both calls MUST stay synchronous — see "iOS popup blocker" below.
          const { callUrl } = incoming.call.accept();
          window.open(callUrl, '_blank');
        }}
      >
        Accept
      </button>
      <button onClick={() => incoming.call.decline()}>Decline</button>
    </div>
  );
}
```

### Return value

| `status` | Fields |
|---|---|
| `idle` | _(none)_ |
| `ringing` | `call: { callId, hostName, hostAvatar, widgetName, sentAt, accept(), decline() }` |

### Options

| Option | Type | Notes |
|---|---|---|
| `baseUrl` | `string` | Defaults to `https://lobbyside.com`. |
| `visitor` | `{ name?, email?, company?, linkedin?, github? }` | Published to the host's Live tab so they can see who you are before they dial, and pre-filled into the call form on accept. Safe to update across renders. |
| `ringTimeoutMs` | `number` | Auto-decline (with reason `timeout`) after this many ms. Defaults to `30000`. |

### iOS Safari popup blocker

iOS only honors `window.open` when it's called *synchronously* from a user gesture. `accept()` is intentionally synchronous (no `await`, no Promise) so you can chain it directly:

```tsx
// GOOD — both calls are sync, gesture survives.
onClick={() => {
  const { callUrl } = incoming.call.accept();
  window.open(callUrl, '_blank');
}}

// BAD — the await drops the gesture; iOS silently swallows the popup.
onClick={async () => {
  const { callUrl } = await somethingAsync();
  window.open(callUrl, '_blank');
}}
```

If you'd rather navigate in-tab, do `window.location.href = callUrl` instead — same rule still applies.

### Headless audio

`@lobbyside/react` doesn't play a ringtone — bring your own if you want one. A simple pattern:

```tsx
useEffect(() => {
  if (incoming.status !== 'ringing') return;
  const a = new Audio('/your-ringtone.mp3');
  a.loop = true;
  a.play().catch(() => {});
  return () => { a.pause(); };
}, [incoming.status]);
```

### Pairing with `useLobbyside`

Both hooks share the underlying InstantDB connection — mounting both for the same `widgetId` is cheap. Use `useLobbyside` to render the "Join 1:1" CTA, and `useLobbysideIncomingCall` to handle the inbound case where the host dials you instead. A typical full widget looks like:

```tsx
import { useLobbyside, useLobbysideIncomingCall } from '@lobbyside/react';

export function LobbysideWidget() {
  const widget = useLobbyside('YOUR_WIDGET_ID');
  const incoming = useLobbysideIncomingCall('YOUR_WIDGET_ID', {
    visitor: { name: 'Ada Lovelace', email: 'ada@example.com' },
  });

  if (incoming.status === 'ringing') {
    return (
      <div role="dialog" aria-label="Incoming call">
        <p><strong>{incoming.call.hostName}</strong> is calling</p>
        <button
          onClick={() => {
            const { callUrl } = incoming.call.accept();
            window.open(callUrl, '_blank');
          }}
        >
          Accept
        </button>
        <button onClick={() => incoming.call.decline()}>Decline</button>
      </div>
    );
  }

  if (widget.status === 'loading' || widget.status === 'error') return null;

  return (
    <div>
      <img src={widget.avatarUrl} alt={widget.hostName} />
      <h3>{widget.hostName}</h3>
      {widget.status === 'online' ? (
        <button
          disabled={widget.isQueueFull}
          onClick={async () => {
            const { entryUrl } = await widget.joinCall({
              visitor: { name: 'Ada Lovelace', email: 'ada@example.com' },
            });
            window.open(entryUrl, '_blank');
          }}
        >
          {widget.isQueueFull ? 'Queue is full' : widget.buttonText}
        </button>
      ) : widget.offlineCtaUrl ? (
        <a href={widget.offlineCtaUrl} target="_blank" rel="noreferrer">
          {widget.offlineButtonText || 'Book a time'}
        </a>
      ) : (
        <p>Currently offline. Check back later.</p>
      )}
    </div>
  );
}
```

The ringing branch takes priority so an inbound call surfaces even while the visitor is mid-interaction with the CTA.

## Self-hosted or local dev

Point at a different origin with the `baseUrl` option. Works with every call shape:

```tsx
useLobbyside('YOUR_WIDGET_ID', { baseUrl: 'http://localhost:3000' });
useLobbyside({ widgetId: 'YOUR_WIDGET_ID', baseUrl: 'http://localhost:3000' });
useLobbyside({ orgId: 'YOUR_ORG_ID', baseUrl: 'http://localhost:3000' });

useLobbysideIncomingCall('YOUR_WIDGET_ID', { baseUrl: 'http://localhost:3000' });
useLobbysideIncomingCall({ orgId: 'YOUR_ORG_ID', baseUrl: 'http://localhost:3000' });
```
