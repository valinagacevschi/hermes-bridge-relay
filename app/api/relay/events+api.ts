// Generated from expo-hermes; edit the private source, not this mirror.
import db from "@/lib/db";
import redis from "@/lib/redis";
import {
  EVENTS_RATE_LIMIT_PER_MINUTE,
  EVENTS_RATE_LIMIT_WINDOW_S,
  categoryFor,
  isFreshTimestamp,
  sanitizeEventData,
  templateFor,
  verifyEventSignature,
} from "@/lib/relay-events";

type EventBody = {
  profile_id?: string;
  event_type?: string;
  ts?: number;
  data?: Record<string, unknown>;
};

export async function POST(request: Request): Promise<Response> {
  // Read raw text first — the signature is computed over the exact bytes
  // sent, not a re-serialization of the parsed object.
  const rawBody = await request.text();

  let body: EventBody;
  try {
    body = JSON.parse(rawBody) as EventBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const { profile_id, event_type, ts, data } = body;
  if (!profile_id || !event_type) {
    return Response.json({ error: "profile_id and event_type required" }, { status: 400 });
  }

  // profile_id is read only from the signed body (never a query param or
  // header) — otherwise a signature valid for one profile could be replayed
  // against another by swapping an unsigned field.
  const { rows } = await db.query<{ key: string }>(
    "SELECT key FROM api_keys WHERE profile_id = $1",
    [profile_id]
  );
  const signature = request.headers.get("X-Hub-Signature-256");
  if (
    !rows.length ||
    !verifyEventSignature(
      rows.map((r) => r.key),
      rawBody,
      signature
    )
  ) {
    console.warn(`[relay/events] rejected: bad/missing signature for profile ${profile_id}`);
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isFreshTimestamp(ts, Date.now())) {
    console.warn(`[relay/events] rejected: stale/missing ts for profile ${profile_id}`);
    return Response.json({ error: "stale_event" }, { status: 401 });
  }

  const category = categoryFor(event_type);
  if (!category) {
    return Response.json({ error: "unknown_event_type" }, { status: 400 });
  }

  const rateKey = `relay:events:${profile_id}`;
  const count = await redis.incr(rateKey);
  if (count === 1) {
    await redis.expire(rateKey, EVENTS_RATE_LIMIT_WINDOW_S);
  }
  if (count > EVENTS_RATE_LIMIT_PER_MINUTE) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  // Generic template only. `data` is sanitized to a fixed allowlist of
  // structural routing keys (screen/tab/run_id/subsystem) — never trust the
  // caller's `data` object verbatim, or a compromised/buggy gateway could
  // smuggle free text (or override category/event_type) straight through
  // to server/push.ts and the device. category/event_type are then set
  // from server-computed values, always winning over anything a caller tried
  // to sneak into `data` under those same keys. profile_id must also live in
  // data because Expo only delivers that nested object to the client handler.
  const { title, body: notifBody } = templateFor(category, event_type);
  const payload = JSON.stringify({
    profile_id,
    title,
    body: notifBody,
    data: { ...sanitizeEventData(data), profile_id, category, event_type },
  });
  await redis.publish(`hermes:${profile_id}:notify`, payload);

  return Response.json({ ok: true });
}
