// Generated from expo-hermes; edit the private source, not this mirror.
import { config } from "dotenv";

import db from "@/lib/db";
import redis from "@/lib/redis";
import { chatCategoryFor } from "@/lib/relay-events";
import { allocateAndInsert, evictBeyondCap } from "@/lib/relay-queue";

config({ override: true });

/**
 * Gateway->relay durable enqueue. Called by `send()` in
 * plugins/platforms/hermes_bridge/adapter.py for every real (non-streaming)
 * outbound message. Persists the E2E-sealed frame (relay never decrypts it) so
 * it survives the phone being offline, publishes it live on `:out` for a
 * connected phone, and triggers a generic push via the existing `:notify`
 * pipeline (server/push.ts). `_send_run_event` frames never call this — only
 * `send()` does, making the gateway the semantic authority on what's durable.
 *
 * Optional `category` (#50) routes the notification tap; see docs/architecture.md.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer hb_")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const key = auth.slice("Bearer ".length);

  const { rows: keyRows } = await db.query<{ profile_id: string; profile_name: string }>(
    `SELECT api_keys.profile_id, profiles.name AS profile_name
     FROM api_keys
     JOIN profiles ON profiles.id = api_keys.profile_id
     WHERE api_keys.key = $1`,
    [key]
  );
  if (!keyRows[0]) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { profile_id, profile_name } = keyRows[0];

  const body = await request.json().catch(() => ({}));
  const { msg_id, sealed_frame, category } = body as {
    msg_id?: string;
    sealed_frame?: string;
    category?: string;
  };
  if (!msg_id || !sealed_frame) {
    return Response.json({ error: "msg_id and sealed_frame required" }, { status: 400 });
  }

  const client = await db.connect();
  let seq: number;
  let alreadyEnqueued = false;
  try {
    await client.query("BEGIN");
    const allocated = await allocateAndInsert(client, {
      queue: "messages",
      profileId: profile_id,
      msgId: msg_id,
      sealedFrame: sealed_frame,
    });
    seq = allocated.seq;
    // A retried gateway POST is an idempotent no-op — no re-eviction, and no
    // second push below.
    alreadyEnqueued = !allocated.isNew;
    if (allocated.isNew) {
      // Same transaction as the insert, so there is no window for a concurrent
      // /pending read to see rows gone with a stale floor.
      await evictBeyondCap(client, profile_id);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Live delivery to any connected phone — unchanged path.
  await redis.publish(`hermes:${profile_id}:out`, sealed_frame);

  // Metadata-only push — relay never has the PSK, so the body must never carry
  // message plaintext. The laptop name is the approved non-message fallback:
  // the relay already stores it in `profiles` and returns it during pairing.
  if (!alreadyEnqueued) {
    const chatCategory = chatCategoryFor(category);
    await redis.publish(
      `hermes:${profile_id}:notify`,
      JSON.stringify({
        profile_id,
        title: "Hermes",
        body: `New message from ${profile_name}`,
        // profile_id in `data` (not just the top-level publish payload) — the
        // client's notification handler needs it to know which profile to
        // pending-sync (see app/_layout.tsx, lib/pending-sync.ts).
        data: {
          seq,
          msg_id,
          profile_id,
          ...(chatCategory ? { category: chatCategory, screen: "chat" } : {}),
        },
      })
    );
  }

  return Response.json({ ok: true, seq });
}
