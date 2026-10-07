// Generated from expo-hermes; edit the private source, not this mirror.
import { randomUUID } from "node:crypto";

import { config } from "dotenv";
import Redis from "ioredis";

import { requireApiKey } from "@/lib/auth";
import db from "@/lib/db";
import redis from "@/lib/redis";
import { allocateAndInsert } from "@/lib/relay-queue";

config({ override: true });

// Upper bound the relay holds a synchronous RPC POST open waiting for the
// gateway's reply. Comfortably above a slow Hermes call (~600ms) yet short
// enough that a truly offline gateway surfaces as an error, not a hang.
const RPC_REPLY_TIMEOUT_MS = 12_000;

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const {
    profile_id,
    content,
    role = "user",
    rpc_id,
    msg_id,
  } = body as {
    profile_id?: string;
    content?: string;
    role?: string;
    rpc_id?: string;
    msg_id?: string;
  };

  if (!profile_id || !content) {
    return Response.json({ error: "profile_id and content required" }, { status: 400 });
  }

  const authErr = await requireApiKey(request, profile_id);
  if (authErr) return authErr;

  // Durable phone->gateway queue (#41) — RPC excluded: a synchronous caller
  // that already timed out waiting for a reply gains nothing from a later
  // durable redelivery. Insert unconditionally (mirrors enqueue+api.ts's
  // established insert-then-publish pattern) rather than gating on whether
  // the gateway looks connected right now — checking a redis subscriber
  // count before deciding to persist is racy (a socket can drop between the
  // check and the publish). The existing 503-on-no-receivers response
  // contract below is intentionally UNCHANGED — durability is added
  // underneath it, invisibly to the client's offline-banner UX.
  let seq: number | null = null;
  if (role !== "rpc.request") {
    // Old-app skew: a client built before #41 has no top-level msg_id — mint
    // one server-side so the message can still be durably enqueued (loses
    // cross-retry idempotency for that one request, not delivery).
    const dedupId = msg_id ?? randomUUID();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // No cap or floor here (unlike the gateway->phone queue): the gateway
      // has no chat UI to render a gap notice in, so inbound_messages is
      // age-pruned only — see server/push.ts pruneInboundMessages.
      ({ seq } = await allocateAndInsert(client, {
        queue: "inbound_messages",
        profileId: profile_id,
        msgId: dedupId,
        sealedFrame: content,
      }));
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const inEnvelope = JSON.stringify(seq !== null ? { role, content, seq } : { role, content });

  // Synchronous RPC: subscribe to the reply channel BEFORE publishing (Redis
  // pub/sub has no replay), publish the request, then return the gateway's
  // correlated response in the HTTP body. This removes RPC's dependency on the
  // lossy/flaky receive stream — a response can no longer be dropped in a
  // reconnect gap.
  if (role === "rpc.request" && rpc_id) {
    const sub = new Redis(process.env.REDIS_URL!);
    // See server/http.ts — an unhandled ioredis "error" event crashes the process.
    sub.on("error", (err) => console.error("[relay-message] redis error:", err));
    try {
      await sub.subscribe(`hermes:${profile_id}:rpcout`);

      const reply = new Promise<string | null>((resolve) => {
        sub.on("message", (_channel, raw) => {
          try {
            const o = JSON.parse(raw) as { rpc_id?: string; frame?: string };
            if (o.rpc_id === rpc_id && typeof o.frame === "string") resolve(o.frame);
          } catch {
            // ignore malformed reply
          }
        });
      });

      const receivers = await redis.publish(`hermes:${profile_id}:in`, inEnvelope);
      if (receivers === 0) {
        return Response.json({ error: "hermes_offline" }, { status: 503 });
      }

      const frame = await Promise.race([
        reply,
        new Promise<null>((r) => setTimeout(() => r(null), RPC_REPLY_TIMEOUT_MS)),
      ]);

      if (!frame) {
        return Response.json({ error: "rpc_timeout" }, { status: 504 });
      }
      return Response.json({ frame });
    } finally {
      sub.quit();
    }
  }

  // Chat / other: fire-and-forget publish; replies arrive over the receive stream.
  const receivers = await redis.publish(`hermes:${profile_id}:in`, inEnvelope);
  if (receivers === 0) {
    return Response.json({ error: "hermes_offline" }, { status: 503 });
  }
  return Response.json({ ok: true });
}
