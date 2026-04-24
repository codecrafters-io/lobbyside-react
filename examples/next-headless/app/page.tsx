"use client";

import { useState } from "react";
import { useLobbyside, type LobbysideWidgetState } from "@lobbyside/react";

// Initial widget ID from env. User can change it via the form field.
const DEFAULT_WIDGET_ID = process.env.NEXT_PUBLIC_EXAMPLE_WIDGET_ID ?? "REPLACE_ME";
const BASE_URL = process.env.NEXT_PUBLIC_EXAMPLE_BASE_URL ?? "http://localhost:3000";

/** Stringify the widget state, skipping the joinCall function. */
function widgetToJson(widget: LobbysideWidgetState): string {
  return JSON.stringify(
    widget,
    (key, value) => (typeof value === "function" ? "[Function]" : value),
    2,
  );
}

export default function Page() {
  const [widgetId, setWidgetId] = useState(DEFAULT_WIDGET_ID);
  const widget = useLobbyside(widgetId, { baseUrl: BASE_URL });

  const hasIdentity = widget.status === "offline" || widget.status === "online";

  return (
    <main style={{ padding: 32, maxWidth: 640, margin: "40px auto" }}>
      <h1>Lobbyside headless example</h1>

      <label
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 13,
          color: "#666",
          marginBottom: 16,
        }}
      >
        Widget ID
        <input
          type="text"
          value={widgetId}
          onChange={(e) => setWidgetId(e.target.value.trim())}
          spellCheck={false}
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontSize: 13,
            padding: "8px 10px",
            border: "1px solid #ccc",
            borderRadius: 6,
            color: "#111",
            background: "#fff",
          }}
        />
      </label>

      <p style={{ color: "#666" }}>
        status: <strong>{widget.status}</strong>
      </p>

      {widget.status === "loading" && <p>Loading…</p>}

      {widget.status === "error" && (
        <p style={{ color: "crimson" }}>
          Error ({widget.error.code}): {widget.error.message}
        </p>
      )}

      {hasIdentity && (
        <div
          style={{
            background: "#fff",
            color: "#111",
            border: "1px solid #ddd",
            borderRadius: 12,
            padding: 16,
            width: 360,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            opacity: widget.status === "offline" ? 0.75 : 1,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {widget.avatarUrl && (
              // referrerPolicy: no-referrer works around Chrome's Opaque
              // Response Blocking for third-party avatar hosts like
              // lh3.googleusercontent.com that otherwise 403/ORB the img
              // load when referred from a different origin.
              <img
                src={widget.avatarUrl}
                alt={widget.hostName}
                referrerPolicy="no-referrer"
                style={{ width: 48, height: 48, borderRadius: "50%" }}
              />
            )}
            <div>
              <div style={{ fontWeight: 600 }}>{widget.hostName}</div>
              <div style={{ opacity: 0.7, fontSize: 14 }}>
                {widget.hostTitle}
              </div>
            </div>
          </div>

          <p>{widget.ctaText}</p>

          {widget.status === "online" ? (
            <button
              disabled={widget.isQueueFull}
              onClick={async () => {
                try {
                  const { entryUrl } = await widget.joinCall({
                    visitor: { name: "Demo Visitor", email: "demo@example.com" },
                  });
                  window.open(entryUrl, "_blank");
                } catch (err) {
                  alert(
                    `${(err as { code: string }).code}: ${(err as Error).message}`,
                  );
                }
              }}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                border: "none",
                background: widget.isQueueFull ? "#ccc" : "#111",
                color: widget.isQueueFull ? "#666" : "#fff",
                cursor: widget.isQueueFull ? "not-allowed" : "pointer",
              }}
            >
              {widget.isQueueFull ? "Queue is full" : widget.buttonText}
            </button>
          ) : (
            <p style={{ opacity: 0.6, fontSize: 14, fontStyle: "italic" }}>
              Currently offline — check back later.
            </p>
          )}
        </div>
      )}

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 0.5, color: "#666" }}>
          Hook state
        </h2>
        <pre
          style={{
            background: "#f4f4f4",
            color: "#111",
            padding: 16,
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.5,
            overflow: "auto",
          }}
        >
          {widgetToJson(widget)}
        </pre>
      </section>
    </main>
  );
}
