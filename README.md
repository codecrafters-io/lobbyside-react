# @lobbyside/react

Render your own custom widget UI against a live [Lobbyside](https://lobbyside.com) widget. This package gives you the host's identity (name, title, avatar, copy) plus a live queue state and a join action — you bring the UI.

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
      ) : (
        <p>Currently offline — check back later</p>
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

## Self-hosted or local dev

Point at a different origin with the `baseUrl` option:

```tsx
useLobbyside('YOUR_WIDGET_ID', { baseUrl: 'http://localhost:3000' });
```
