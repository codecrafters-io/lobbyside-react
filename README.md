# @lobbyside/react

Render your own custom widget UI against a live [Lobbyside](https://lobbyside.com) widget. Two hooks:

- `useLobbyside` — host identity, online/offline + queue state, and a `joinCall` action for the "Join 1:1" CTA.
- `useLobbysideIncomingCall` — make a visitor reachable from the host's Live tab; ring on incoming calls and offer `accept` / `decline`.

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

`useLobbyside` returns one of four states:

- `{ status: 'loading' }` — initial render, before the first HTTP fetch resolves.
- `{ status: 'error', error: LobbysideError }` — the widget ID doesn't exist (`NOT_FOUND`) or the request failed (`NETWORK`).
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

## Errors

`joinCall` throws `LobbysideError`. Branch on `err.code`:

- `QUEUE_FULL` — thrown client-side when `isQueueFull === true`, or server-side if the queue filled between render and click.
- `INACTIVE` — the widget was toggled off mid-click.
- `NOT_FOUND` — the widget ID doesn't exist.
- `NETWORK` — anything else (fetch rejection, unexpected HTTP status, malformed JSON).

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

Point at a different origin with the `baseUrl` option:

```tsx
useLobbyside('YOUR_WIDGET_ID', { baseUrl: 'http://localhost:3000' });
useLobbysideIncomingCall('YOUR_WIDGET_ID', { baseUrl: 'http://localhost:3000' });
```
