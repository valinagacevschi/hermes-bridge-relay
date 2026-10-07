// Generated from expo-hermes; edit the private source, not this mirror.
import { createServer } from "http";
import type { IncomingMessage } from "http";
import { config } from "dotenv";
import Redis from "ioredis";
import { Pool } from "pg";
import { type WebSocket, WebSocketServer } from "ws";

config({ override: true });

// Last-resort backstop — see server/http.ts for the reasoning.
process.on("uncaughtException", (err) => console.error("[relay-ws] uncaught exception:", err));
process.on("unhandledRejection", (err) => console.error("[relay-ws] unhandled rejection:", err));

const REDIS_URL = process.env.REDIS_URL!;
const PORT = Number(process.env.RELAY_WS_PORT ?? 8082);

// Capability handshake sent to the gateway adapter right after connect. Plaintext
// JSON (the relay holds no PSK and cannot seal) — mirrors Hermes core's own
// experimental relay-connector contract (gateway/relay/descriptor.py
// CapabilityDescriptor) so this bridge speaks the same op vocabulary rather than
// inventing a parallel one. `supported_ops` outside this list are unknown to the
// gateway and MUST fall back to its LEGACY_OPS default (send/edit/typing/
// follow_up) — see docs/architecture.md's frame-taxonomy table for the full
// backward-compat contract. Downlink-only: never sent to role=mobile (its
// primary receive path is SSE, not this WS — see lib/relay-stream.ts).
type CapabilityDescriptor = {
  type: "hello";
  contract_version: number;
  platform: string;
  label: string;
  max_message_length: number;
  supports_draft_streaming: boolean;
  supports_edit: boolean;
  supports_threads: boolean;
  markdown_dialect: string;
  len_unit: "chars" | "utf16";
  supported_ops: string[];
  // Transport capability, not an op name (#41) — whether this relay can
  // replay a phone->gateway backlog on reconnect (see the `since` handling
  // in handleConnection below). Descriptor-parity-only: the adapter sends
  // `?since=` on every connect regardless, so nothing branches on this flag
  // today — same honesty precedent as max_message_length above.
  supports_replay: boolean;
};

const DESCRIPTOR: CapabilityDescriptor = {
  type: "hello",
  contract_version: 1,
  platform: "hermes_bridge",
  label: "HermLink",
  max_message_length: 4096,
  supports_draft_streaming: false,
  supports_edit: true,
  supports_threads: false,
  markdown_dialect: "plain",
  len_unit: "chars",
  // Honest current capability — send_media (blob upload/download works),
  // edit (expect_edits + edit_message streaming works), react (#45 —
  // app/(drawer)/chat/[profile_id].tsx's onFrame has a dedicated `role:
  // "react"` branch that never inserts a chat message, shipped in the same
  // change that adds this op — see docs/architecture.md's "Reaction-ack
  // lifecycle" section for the one-release skew this leaves for a phone
  // that hasn't updated at all). Do not add an op here that isn't actually
  // implemented; a new adapter only tries new ops when it sees them
  // advertised, so advertising ahead of implementation would surface as a
  // runtime failure, not a graceful degrade.
  supported_ops: ["send", "edit", "follow_up", "send_media", "prompt", "react"],
  supports_replay: true,
};

// Backlog replay page size on gateway reconnect (#41) — mirrors PAGE_LIMIT in
// app/api/relay/pending/[profile_id]+api.ts. A gateway offline long enough to
// exceed this in one connect cycle is a pathological case; not paginated
// further today (non-goal — see docs/architecture.md).
const REPLAY_PAGE_LIMIT = 500;

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
// See lib/db.ts — an unhandled pg.Pool "error" event is fatal to the process.
pool.on("error", (err) => console.error("[relay-ws] pg pool error:", err));
const pub = new Redis(REDIS_URL);
// See app/api/relay/stream — an unhandled ioredis "error" event crashes the process.
pub.on("error", (err) => console.error("[relay-ws] redis pub error:", err));
const httpServer = createServer();
httpServer.on("error", (err) => console.error("[relay-ws] http server error:", err));
const wss = new WebSocketServer({ server: httpServer });
wss.on("error", (err) => console.error("[relay-ws] websocket server error:", err));

async function handleConnection(ws: WebSocket, req: IncomingMessage) {
  const url = new URL(req.url!, "http://localhost");
  const m = url.pathname.match(/^\/ws\/hermes\/([^/]+)$/);
  if (!m) {
    ws.close(1008, "Not Found");
    return;
  }

  const profile_id = m[1];
  const api_key = url.searchParams.get("api_key") ?? "";
  // role=gateway (default): laptop adapter — reads :in, writes :out.
  // role=mobile: phone receive path (SSE→WS fallback for proxies that buffer
  // SSE, e.g. Netskope) — reads :out only. Mobile keeps POSTing to send.
  const role = url.searchParams.get("role") === "mobile" ? "mobile" : "gateway";

  const { rows } = await pool.query("SELECT 1 FROM api_keys WHERE key = $1 AND profile_id = $2", [
    api_key,
    profile_id,
  ]);
  if (!rows.length) {
    ws.close(1008, "Unauthorized");
    return;
  }

  const channel = role === "mobile" ? "out" : "in";
  const sub = new Redis(REDIS_URL);
  sub.on("error", (err) => console.error(`[relay-ws] redis sub error (${role}):`, err));

  // Gateway reconnect replay (#41): subscribe first (per the same "subscribe
  // before publish" reasoning as the RPC path in message+api.ts), then buffer
  // any live `:in` messages that arrive while the backlog below is still
  // being sent, so a live message can never be forwarded ahead of an older
  // backlog row. Flushed once the ordered backlog send completes. No-op for
  // role=mobile (draining stays false — that side has its own replay via
  // GET /api/relay/pending, unrelated to this WS).
  let draining = role === "gateway";
  const liveBuffer: string[] = [];

  sub.subscribe(`hermes:${profile_id}:${channel}`);
  sub.on("message", (_, msg) => {
    if (draining) {
      liveBuffer.push(msg);
      return;
    }
    ws.send(msg);
  });
  console.log(`[ws] ${role} connected: ${profile_id}`);

  // Handshake — gateway only (see DESCRIPTOR comment above).
  if (role === "gateway") {
    ws.send(JSON.stringify(DESCRIPTOR));

    const since = Number(url.searchParams.get("since") ?? "0") || 0;
    try {
      const { rows: backlog } = await pool.query<{ seq: string; sealed_frame: string }>(
        "SELECT seq, sealed_frame FROM inbound_messages WHERE profile_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3",
        [profile_id, since, REPLAY_PAGE_LIMIT]
      );
      for (const row of backlog) {
        // role is always "user" here — the only durably-queued producer of
        // inbound_messages (app/api/relay/message+api.ts) excludes rpc.request.
        ws.send(JSON.stringify({ role: "user", content: row.sealed_frame, seq: Number(row.seq) }));
      }
    } catch (err) {
      console.error("[ws] backlog replay error:", err);
    }
    draining = false;
    for (const msg of liveBuffer) ws.send(msg);
    liveBuffer.length = 0;

    // End-of-backlog marker. The adapter accepts deliberately-stale frames
    // (allow_stale) only while a replay is genuinely in progress; without
    // this it can only guess, by timing a grace window off its own connect
    // clock, which leaves the bypass open for the whole window. Sent AFTER
    // the liveBuffer flush, not before it: a live message buffered during a
    // slow drain would otherwise arrive once the window had already closed
    // and be rejected for having aged past the 60s freshness check.
    ws.send(JSON.stringify({ type: "backlog_done" }));
  }

  // Heartbeat: ping every 25s so idle connections aren't culled by intermediary
  // proxies (e.g. Netskope) between messages. The Python gateway self-pings, but
  // the mobile RN WebSocket does not — without this, the :out socket drops on
  // idle and the app's connection flaps to "offline". 25s < typical 30-60s idle
  // windows.
  const heartbeat = setInterval(() => {
    try {
      ws.ping();
    } catch {
      // socket already closing — close handler will clean up
    }
  }, 25_000);

  // Only the gateway writes replies back. Mobile is receive-only (sends via POST).
  if (role === "gateway") {
    ws.on("message", (msg) => {
      const text = msg.toString();
      // Synchronous-RPC responses arrive as a typed envelope {type:"rpc",rpc_id,
      // frame}; route them to the per-profile reply channel so the waiting POST
      // can correlate and return the frame. Chat replies and run.event frames are
      // bare base64 (not JSON) and fall through to the broadcast :out channel.
      try {
        const env = JSON.parse(text) as { type?: string; rpc_id?: string; frame?: string };
        if (env && env.type === "rpc" && typeof env.rpc_id === "string") {
          pub.publish(
            `hermes:${profile_id}:rpcout`,
            JSON.stringify({ rpc_id: env.rpc_id, frame: env.frame })
          );
          return;
        }
      } catch {
        // not JSON — a bare sealed frame
      }
      pub.publish(`hermes:${profile_id}:out`, text);
    });
  }
  // Same reasoning as the Redis/pg clients above — an unhandled "error" on
  // this socket (protocol error, reset, etc.) is fatal to the process, and
  // "close" always follows an "error" anyway so no extra cleanup is needed here.
  ws.on("error", (err) => console.error(`[ws] socket error (${role}):`, err));
  ws.on("close", () => {
    clearInterval(heartbeat);
    sub.quit();
    console.log(`[ws] ${role} disconnected: ${profile_id}`);
  });
}

wss.on("connection", (ws, req) => {
  handleConnection(ws, req).catch((err) => {
    console.error("[ws] connection error:", err);
    ws.close(1011, "Internal Error");
  });
});

httpServer.listen(PORT, () => console.log(`Relay WS listening on :${PORT}`));
