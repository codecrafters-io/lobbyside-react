"use client";

import { useState } from "react";
import {
  useLobbyside,
  useLobbysideIncomingCall,
  type LobbysideWidgetState,
  type LobbysideIncomingCallState,
} from "@lobbyside/react";

const DEFAULT_WIDGET_ID = process.env.NEXT_PUBLIC_EXAMPLE_WIDGET_ID ?? "REPLACE_ME";
const BASE_URL = process.env.NEXT_PUBLIC_EXAMPLE_BASE_URL ?? "http://localhost:3000";

function stateToJson(
  state: LobbysideWidgetState | LobbysideIncomingCallState,
): string {
  return JSON.stringify(
    state,
    (_key, value) => (typeof value === "function" ? "[Function]" : value),
    2,
  );
}

export default function Page() {
  const [widgetId, setWidgetId] = useState(DEFAULT_WIDGET_ID);
  const [visitorName, setVisitorName] = useState("Demo Visitor");
  const [visitorEmail, setVisitorEmail] = useState("demo@example.com");
  const widget = useLobbyside(widgetId, { baseUrl: BASE_URL });
  const incoming = useLobbysideIncomingCall(widgetId, {
    baseUrl: BASE_URL,
    visitor: { name: visitorName, email: visitorEmail },
  });

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

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#666" }}>
          Visitor name
          <input
            type="text"
            value={visitorName}
            onChange={(e) => setVisitorName(e.target.value)}
            style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, color: "#111", background: "#fff" }}
          />
        </label>
        <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#666" }}>
          Visitor email
          <input
            type="email"
            value={visitorEmail}
            onChange={(e) => setVisitorEmail(e.target.value)}
            style={{ padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, color: "#111", background: "#fff" }}
          />
        </label>
      </div>

      <p style={{ color: "#666" }}>
        status: <strong>{widget.status}</strong>
        {" | "}
        ring: <strong>{incoming.status}</strong>
      </p>

      {incoming.status === "ringing" && (
        <div
          style={{
            background: "#fffbe6",
            border: "1px solid #f1c40f",
            borderRadius: 12,
            padding: 16,
            width: 360,
            marginBottom: 16,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {incoming.call.hostAvatar && (
              <img
                src={incoming.call.hostAvatar}
                alt={incoming.call.hostName}
                referrerPolicy="no-referrer"
                style={{ width: 40, height: 40, borderRadius: "50%" }}
              />
            )}
            <div style={{ color: "#111" }}>
              <strong>{incoming.call.hostName}</strong> is calling
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                if (incoming.status !== "ringing") return;
                const { callUrl } = incoming.call.accept();
                window.open(callUrl, "_blank");
              }}
              style={{
                flex: 1,
                padding: "10px 16px",
                borderRadius: 8,
                border: "none",
                background: "#16a34a",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Accept
            </button>
            <button
              onClick={() => {
                if (incoming.status === "ringing") incoming.call.decline();
              }}
              style={{
                flex: 1,
                padding: "10px 16px",
                borderRadius: 8,
                border: "none",
                background: "#dc2626",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Decline
            </button>
          </div>
        </div>
      )}

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
                    visitor: { name: visitorName, email: visitorEmail },
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

      <section style={{ marginTop: 32, display: "grid", gap: 16 }}>
        <div>
          <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 0.5, color: "#666" }}>
            useLobbyside state
          </h2>
          <pre style={preStyle}>{stateToJson(widget)}</pre>
        </div>
        <div>
          <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 0.5, color: "#666" }}>
            useLobbysideIncomingCall state
          </h2>
          <pre style={preStyle}>{stateToJson(incoming)}</pre>
        </div>
      </section>
    </main>
  );
}

const preStyle: React.CSSProperties = {
  background: "#f4f4f4",
  color: "#111",
  padding: 16,
  borderRadius: 8,
  fontSize: 12,
  lineHeight: 1.5,
  overflow: "auto",
};
