# @lobbyside/react

Render your own custom widget UI against a live [Lobbyside](https://lobbyside.com) widget. This package gives you the data and behavior (host name, avatar, CTA text, live state, queue-full state, and a join action) — you bring the UI.

If you just want a drop-in widget with our default look, use the script-tag install instead.

## Install

    npm install @lobbyside/react

Peer dependencies: `react >= 18` and `@instantdb/core >= 1.0`.

## Usage

```tsx
import { useLobbyside } from '@lobbyside/react';

export function MyCTA() {
  const widget = useLobbyside('YOUR_WIDGET_ID');

  if (widget.status !== 'online') return null;

  return (
    <div>
      <img src={widget.avatarUrl} alt={widget.hostName} />
      <h3>{widget.hostName}</h3>
      <p>{widget.ctaText}</p>
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
    </div>
  );
}
```

## Return value

`useLobbyside` returns one of four states:

- `{ status: 'loading' }` — initial render, before the first HTTP fetch resolves.
- `{ status: 'offline' }` — the widget exists but the host has it toggled off.
- `{ status: 'error', error: LobbysideError }` — the widget ID doesn't exist (`NOT_FOUND`) or the request failed (`NETWORK`).
- `{ status: 'online', ... }` — live. Fields below.

### Online fields

| Field | Type | Notes |
|---|---|---|
| `hostName` | `string` | |
| `hostTitle` | `string` | |
| `avatarUrl` | `string` | |
| `ctaText` | `string` | |
| `buttonText` | `string` | |
| `isQueueFull` | `boolean` | Live — flips to `true` when `queuedCount >= maxQueueSize`. |
| `joinCall(args?)` | `() => Promise<{ entryUrl: string }>` | POSTs to Lobbyside. Open `entryUrl` in a new tab on success. |
| `meetLink` | `string` | Static fallback URL configured on the widget. |
| `slug` | `string` | |
| `maxQueueSize` | `number` | |
| `theme` | `string?` | For customers who want to match our own card palette. |
| `customBgColor` | `string \| null` | |
| `customAccentColor` | `string \| null` | |
| `boldFont` | `string \| null` | |

### Passing visitor data

```tsx
await widget.joinCall({
  visitor: { name: 'Ada', email: 'ada@example.com' },
});
```

Keys recognized by the server today: `name`, `email`, `company`, `github`.

## Errors

`joinCall` throws `LobbysideError`. Branch on `err.code`:

- `QUEUE_FULL` — thrown client-side when `isQueueFull === true`, or server-side if the queue filled between render and click.
- `INACTIVE` — the widget was toggled off mid-click.
- `NOT_FOUND` — the widget ID doesn't exist.
- `NETWORK` — anything else (fetch rejection, unexpected HTTP status, malformed JSON).

## Self-hosted or local dev

Point at a different origin with the `baseUrl` option:

```tsx
useLobbyside('YOUR_WIDGET_ID', { baseUrl: 'http://localhost:3000' });
```
