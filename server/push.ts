// Generated from expo-hermes; edit the private source, not this mirror.
/**
 * Push notification delivery server.
 *
 * Subscribes to hermes:*:notify pattern on Redis.
 * Each message is JSON { profile_id, title, body, data }.
 * A profile can have several paired phones (expo_push_tokens), but only the
 * most recently paired one is sent a push — one profile, one notified device.
 * Permanently dead tokens (`DeviceNotRegistered`, APNs `BadDeviceToken`) are
 * pruned from the array; other error types (rate limits, bad credentials,
 * oversized payload) are transient/config issues and are left alone.
 *
 * Run alongside relay-http: `node server/push.mjs`
 * (compiled by esbuild in the same Docker build step as http/ws)
 */

import { config } from "dotenv";
import Redis from "ioredis";
import { Pool } from "pg";

import {
  type ExpoReceipt,
  type PendingTicket,
  RECEIPT_SWEEP_INTERVAL_MS,
  interpretReceipts,
  isDeadTokenError,
  planReceiptSweep,
} from "@/lib/push-receipts";
import { pickNotifyToken } from "@/lib/push-targeting";
// Safe here, unlike in the transpile-only server entrypoints: the Dockerfile
// bundles push.ts specifically so it can import from lib/.
import { raiseFloor } from "@/lib/relay-queue";

config({ override: true });

// Last-resort backstop — see server/http.ts for the reasoning.
process.on("uncaughtException", (err) => console.error("[push] uncaught exception:", err));
process.on("unhandledRejection", (err) => console.error("[push] unhandled rejection:", err));

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
// See lib/db.ts — an unhandled pg.Pool "error" event is fatal to the process.
pool.on("error", (err) => console.error("[push] pg pool error:", err));
const sub = new Redis(process.env.REDIS_URL!);

type NotifyPayload = {
  profile_id: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
};

/** Outcome of the send call. `dead` means prune now; `ticketId` means the real
 *  verdict is only knowable from the receipt later (#65). */
type SendOutcome = { dead: boolean; ticketId?: string };

async function sendPush(token: string, payload: NotifyPayload): Promise<SendOutcome> {
  const message = {
    to: token,
    title: payload.title ?? "Hermes",
    body: payload.body ?? "",
    data: payload.data ?? {},
    sound: "default",
    priority: "high",
  };

  const resp = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(message),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Expo Push API ${resp.status}: ${text}`);
  }

  const body = (await resp.json()) as {
    data?: { status?: string; id?: string; message?: string; details?: { error?: string } };
  };
  const status = body?.data?.status;
  if (status === "error") {
    const errType = body.data?.details?.error;
    console.warn(`[push] error for ${payload.profile_id}: ${body.data?.message}`);
    // DeviceNotRegistered / BadDeviceToken → prune. Other errors
    // (MessageTooBig, MessageRateExceeded, InvalidCredentials, …) stay.
    return {
      dead: isDeadTokenError(errType, body.data?.details, body.data?.message),
    };
  }
  // Accepted. That is NOT delivery — the ticket only says Expo took it. Keep
  // the id so reconcileReceipts() can find out what actually happened (#65).
  return { dead: false, ticketId: body?.data?.id };
}

async function pruneToken(profileId: string, token: string): Promise<void> {
  await pool.query(
    "UPDATE profiles SET expo_push_tokens = array_remove(expo_push_tokens, $1) WHERE id = $2",
    [token, profileId]
  );
  console.log(`[push] pruned dead token for ${profileId}`);
}

async function handleNotify(profileId: string, raw: string): Promise<void> {
  let payload: NotifyPayload;
  try {
    payload = JSON.parse(raw) as NotifyPayload;
  } catch {
    console.warn("[push] invalid notify message — not JSON");
    return;
  }

  if (!payload.profile_id) payload.profile_id = profileId;

  const { rows } = await pool.query<{ expo_push_tokens: string[] }>(
    "SELECT expo_push_tokens FROM profiles WHERE id = $1",
    [payload.profile_id]
  );

  const tokens = rows[0]?.expo_push_tokens ?? [];
  if (tokens.length === 0) return; // no device registered for push

  // One profile, one notified device — see lib/push-targeting.ts. Multiple
  // phones can still read the same chat, but only one buzzes.
  const token = pickNotifyToken(tokens);
  if (!token) return;
  try {
    const outcome = await sendPush(token, payload);
    if (outcome.dead) {
      await pruneToken(payload.profile_id, token);
    } else {
      if (outcome.ticketId) {
        pendingReceipts.set(outcome.ticketId, {
          profileId: payload.profile_id,
          token,
          sentAt: Date.now(),
        });
      }
      console.log(`[push] accepted for ${payload.profile_id}: "${payload.title}"`);
    }
  } catch (err) {
    console.error("[push] send error:", err);
  }
}

sub.psubscribe("hermes:*:notify", (err) => {
  if (err) {
    console.error("[push] psubscribe error:", err);
    process.exit(1);
  }
  console.log("[push] subscribed to hermes:*:notify");
});

sub.on("pmessage", (_pattern, channel, message) => {
  // channel = "hermes:<profile_id>:notify"
  const profileId = channel.split(":")[1] ?? "";
  handleNotify(profileId, message).catch((err) => console.error("[push] handleNotify error:", err));
});

sub.on("error", (err) => console.error("[push] redis error:", err));

// Prune the durable delivery buffer (`messages` table — not the source of
// truth, client SQLite is). 7 days comfortably covers a phone left offline;
// runs here because relay-push is a singleton (replicas: 1) — no double-run
// across relay-http's 2 replicas.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly

async function prunePendingMessages(): Promise<void> {
  try {
    // #41: age-prune previously left no signal behind — a phone offline past
    // this window silently lost messages with no `gap` notice. Fold the
    // delete into the same floor-raising update enqueue+api.ts's count-cap
    // eviction uses, per-profile, so both eviction paths report through the
    // one mechanism /api/relay/pending checks.
    const { rows } = await pool.query<{ profile_id: string; seq: string }>(
      `DELETE FROM messages
       WHERE created_at < now() - interval '7 days'
       RETURNING profile_id, seq`
    );
    if (rows.length === 0) return;

    const floorByProfile = new Map<string, number>();
    for (const r of rows) {
      const prev = floorByProfile.get(r.profile_id) ?? 0;
      floorByProfile.set(r.profile_id, Math.max(prev, Number(r.seq)));
    }
    for (const [profileId, seq] of floorByProfile) {
      await raiseFloor(pool, profileId, seq);
    }
    console.log(`[push] pruned ${rows.length} stale pending message(s)`);
  } catch (err) {
    console.error("[push] prune error:", err);
  }
}

// Phone->gateway durable queue (#41) — plain age-based prune only, no floor
// tracking: the gateway side has no chat UI to render a gap notice in, only
// a log line (see adapter.py's handling of a seq high-water-mark jump).
async function pruneInboundMessages(): Promise<void> {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM inbound_messages WHERE created_at < now() - interval '7 days'"
    );
    if (rowCount) console.log(`[push] pruned ${rowCount} stale inbound message(s)`);
  } catch (err) {
    console.error("[push] inbound prune error:", err);
  }
}

// Sealed attachment blobs (PRD_Features.md §2.3) — same 7-day window as
// `messages`. Unlike messages, a blob can legitimately be fetched more than
// once (re-viewing an image), so pruning is purely age-based, not
// delivery-based.
async function pruneStaleBlobs(): Promise<void> {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM blobs WHERE created_at < now() - interval '7 days'"
    );
    if (rowCount) console.log(`[push] pruned ${rowCount} stale blob(s)`);
  } catch (err) {
    console.error("[push] blob prune error:", err);
  }
}

// ── Expo receipt reconciliation (#65) ────────────────────────────────────
//
// A ticket means Expo accepted the push; the receipt is where a revoked token
// actually surfaces. Without this, a dead token produced "[push] sent" forever
// and was never pruned, so there was no signal anywhere that delivery had
// stopped. Best-effort by construction: a failure here must never affect
// sending, which is why it lives on its own timer rather than in the send path.
const pendingReceipts = new Map<string, PendingTicket>();

async function reconcileReceipts(): Promise<void> {
  try {
    const { query, abandon } = planReceiptSweep(pendingReceipts, Date.now());
    for (const id of abandon) pendingReceipts.delete(id);
    if (abandon.length > 0) {
      console.warn(`[push] gave up waiting for ${abandon.length} receipt(s)`);
    }
    if (query.length === 0) return;

    const resp = await fetch(EXPO_RECEIPTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ids: query }),
    });
    if (!resp.ok) {
      console.warn(`[push] getReceipts ${resp.status} — retrying next sweep`);
      return;
    }
    const body = (await resp.json()) as { data?: Record<string, ExpoReceipt> };
    const verdicts = interpretReceipts(body?.data, query, pendingReceipts);

    for (const id of verdicts.delivered) pendingReceipts.delete(id);
    for (const f of verdicts.failed) {
      console.warn(`[push] receipt error for ${f.profileId}: ${f.error} ${f.message ?? ""}`);
      pendingReceipts.delete(f.ticketId);
    }
    for (const d of verdicts.dead) {
      console.warn(`[push] ${d.error} for ${d.profileId} — pruning token`);
      await pruneToken(d.profileId, d.token);
      pendingReceipts.delete(d.ticketId);
    }
    if (verdicts.delivered.length > 0) {
      console.log(`[push] ${verdicts.delivered.length} receipt(s) confirmed delivered`);
    }
  } catch (err) {
    console.error("[push] receipt reconciliation error:", err);
  }
}

setInterval(reconcileReceipts, RECEIPT_SWEEP_INTERVAL_MS);

setInterval(prunePendingMessages, PRUNE_INTERVAL_MS);
setInterval(pruneInboundMessages, PRUNE_INTERVAL_MS);
setInterval(pruneStaleBlobs, PRUNE_INTERVAL_MS);
prunePendingMessages().catch((err) => console.error("[push] initial prune error:", err));
pruneInboundMessages().catch((err) => console.error("[push] initial inbound prune error:", err));
pruneStaleBlobs().catch((err) => console.error("[push] initial blob prune error:", err));
