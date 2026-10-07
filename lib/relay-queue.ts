// Generated from expo-hermes; edit the private source, not this mirror.
/**
 * The durable message queues (#41) — one owner for both directions.
 *
 * The relay buffers sealed frames so they survive the other end being offline:
 * `messages` for gateway->phone (drained by GET /api/relay/pending) and
 * `inbound_messages` for phone->gateway (replayed by server/ws.ts on
 * reconnect). Both are per-profile monotonic `seq` spaces with a `msg_id`
 * dedup key, and both are `PRIMARY KEY (profile_id, seq)`.
 *
 * That shared shape was previously written out four times — seq allocation
 * copy-pasted between enqueue+api.ts and message+api.ts differing only in the
 * table name, and floor-raising between enqueue+api.ts and server/push.ts. The
 * copies were free to drift, which is exactly how a cursor bug of this class
 * gets written. Everything about allocation, eviction, the floor and gap
 * detection lives here now.
 *
 * NOT importable from server/ws.ts, server/http.ts or db/migrate.ts: the
 * Dockerfile transpiles those without --bundle and the runtime image carries no
 * lib/. server/push.ts IS bundled (--bundle --packages=external, for
 * lib/push-receipts.ts) so it may import this.
 */

import type { PoolClient } from "pg";

/**
 * Count-cap on the durable gateway->phone buffer — bounds worst-case growth for
 * a profile whose phone never comes back, independent of the age-based prune in
 * server/push.ts (a burst inside the 7-day window would otherwise grow
 * unbounded). Generous: normal chat volume never approaches this.
 */
export const QUEUE_CAP_PER_PROFILE = 1000;

/** Bound on a single catch-up/replay page — callers re-request with the advanced cursor. */
export const PAGE_LIMIT = 500;

/**
 * The two durable queues. `lockKey` is carried per table rather than derived
 * from the name: these are the exact advisory-lock namespaces already in
 * production, and both tables are PRIMARY KEY (profile_id, seq). Change a key
 * and a rolling deploy leaves one replica locking on the old namespace and
 * another on the new one, so they allocate the same seq, the INSERT fails, and
 * the caller loses the message to a 500 it only logs.
 */
export type QueueName = "messages" | "inbound_messages";

const LOCK_KEY: Record<QueueName, (profileId: string) => string> = {
  messages: (profileId) => profileId,
  inbound_messages: (profileId) => `${profileId}:in`,
};

export type AllocateResult = {
  seq: number;
  /** False when this msg_id was already queued — a retried, idempotent call. */
  isNew: boolean;
};

/**
 * Allocate the next per-profile `seq` and insert the sealed frame, or return
 * the existing row's seq if this `msg_id` is already queued.
 *
 * Must run inside a transaction on `client`: the advisory lock is
 * transaction-scoped, and it is what serializes allocation across relay-http's
 * replicas without a separate counter table. Callers own BEGIN/COMMIT so the
 * insert and any follow-up (eviction, floor) commit together.
 */
export async function allocateAndInsert(
  client: PoolClient,
  opts: { queue: QueueName; profileId: string; msgId: string; sealedFrame: string }
): Promise<AllocateResult> {
  const { queue, profileId, msgId, sealedFrame } = opts;

  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY[queue](profileId)]);

  const { rows: existing } = await client.query<{ seq: string }>(
    `SELECT seq FROM ${queue} WHERE profile_id = $1 AND msg_id = $2`,
    [profileId, msgId]
  );
  if (existing[0]) {
    return { seq: Number(existing[0].seq), isNew: false };
  }

  const { rows: next } = await client.query<{ next: string }>(
    queue === "messages"
      ? `SELECT GREATEST(COALESCE(MAX(seq), 0),
          COALESCE((SELECT messages_floor_seq FROM profiles WHERE id = $1), 0)) + 1 AS next
         FROM messages WHERE profile_id = $1`
      : `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ${queue} WHERE profile_id = $1`,
    [profileId]
  );
  const seq = Number(next[0]?.next);
  await client.query(
    `INSERT INTO ${queue} (profile_id, seq, msg_id, sealed_frame) VALUES ($1, $2, $3, $4)`,
    [profileId, seq, msgId, sealedFrame]
  );
  return { seq, isNew: true };
}

/**
 * Raise a profile's eviction floor. `messages_floor_seq` is the highest
 * `messages.seq` ever dropped for the profile, so a caller whose cursor has
 * fallen behind it can be told it missed rows that no longer exist. GREATEST
 * keeps it monotonic against a concurrent writer.
 *
 * Gateway->phone only: the phone is the only side with a chat UI to render a
 * gap notice in. `inbound_messages` surfaces its discontinuities as a gateway
 * log warning instead (see adapter.py's `_read_frame`).
 */
export async function raiseFloor(
  client: Pick<PoolClient, "query">,
  profileId: string,
  seq: number
): Promise<void> {
  await client.query(
    "UPDATE profiles SET messages_floor_seq = GREATEST(messages_floor_seq, $1) WHERE id = $2",
    [seq, profileId]
  );
}

/**
 * Drop the oldest gateway->phone rows beyond `cap` and raise the floor to the
 * highest seq evicted. Same transaction as the insert that triggered it, so
 * there is no window where a concurrent /pending read sees rows gone with a
 * stale floor.
 */
export async function evictBeyondCap(
  client: PoolClient,
  profileId: string,
  cap: number = QUEUE_CAP_PER_PROFILE
): Promise<void> {
  const { rows: evicted } = await client.query<{ seq: string }>(
    `DELETE FROM messages
     WHERE profile_id = $1 AND seq <= (
       SELECT seq FROM messages WHERE profile_id = $1
       ORDER BY seq DESC OFFSET $2 LIMIT 1
     )
     RETURNING seq`,
    [profileId, cap]
  );
  if (evicted.length === 0) return;
  await raiseFloor(client, profileId, Math.max(...evicted.map((r) => Number(r.seq))));
}

/**
 * Whether a caller's `since` cursor has fallen behind the eviction floor, i.e.
 * it is missing rows that no longer exist. Lets the client render a "some
 * messages weren't delivered" notice instead of silently skipping the gap.
 *
 * `since === 0` means "first sync ever" (a freshly-paired device, or a fresh
 * install) — it must never report a gap just because some OTHER, already
 * caught-up device caused an eviction in the past. Only a device that had
 * genuinely progressed past the floor and is now behind it has really missed
 * something. adapter.py's inbound gap check mirrors this guard.
 */
export function computeGap(since: number, floor: number): boolean {
  return since > 0 && since < floor;
}
