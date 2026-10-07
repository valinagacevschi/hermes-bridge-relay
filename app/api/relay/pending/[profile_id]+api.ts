// Generated from expo-hermes; edit the private source, not this mirror.
import { config } from "dotenv";

import { requireApiKey } from "@/lib/auth";
import db from "@/lib/db";
import { PAGE_LIMIT, computeGap } from "@/lib/relay-queue";

config({ override: true });

/**
 * Durable-inbox catch-up. Called by the phone (lib/pending-sync.ts) on
 * foreground, notification receipt/tap, and chat-screen mount. Pub/sub
 * (`:out`) has no replay, so this is the ONLY way to recover messages enqueued
 * while the phone's stream was disconnected. Returns raw sealed frames — the
 * relay never decrypts.
 */
export async function GET(request: Request): Promise<Response> {
  // Server-rendered dynamic routes don't reliably get `params` — extract from
  // the URL directly (see docs/GOTCHAS.md).
  const profile_id = new URL(request.url).pathname.split("/").at(-1)!;

  const authErr = await requireApiKey(request, profile_id);
  if (authErr) return authErr;

  const since = Number(new URL(request.url).searchParams.get("since") ?? "0") || 0;

  const [{ rows }, { rows: profileRows }] = await Promise.all([
    db.query<{ seq: string; msg_id: string; sealed_frame: string }>(
      "SELECT seq, msg_id, sealed_frame FROM messages WHERE profile_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3",
      [profile_id, since, PAGE_LIMIT]
    ),
    db.query<{ messages_floor_seq: string }>(
      "SELECT messages_floor_seq FROM profiles WHERE id = $1",
      [profile_id]
    ),
  ]);

  const messages = rows.map((r) => ({
    seq: Number(r.seq),
    msg_id: r.msg_id,
    sealed_frame: r.sealed_frame,
  }));
  const floor = Number(profileRows[0]?.messages_floor_seq ?? 0);
  const cursor = Math.max(since, floor, messages[messages.length - 1]?.seq ?? 0);
  const gap = computeGap(since, floor);

  return Response.json({ messages, cursor, gap });
}
