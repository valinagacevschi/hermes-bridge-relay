// Generated from expo-hermes; edit the private source, not this mirror.
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import redis from "@/lib/redis";
import { apiKey as genApiKey, hashToken, inviteId, pairToken } from "@/lib/tokens";

const RATE_LIMIT_PER_HOUR = 5;
const PHONE_INVITE_TTL_HOURS = 1;

// Self-serve, unauthenticated pairing — no ADMIN_SECRET. Lets a public user
// with the plugin installed pair without the owner's involvement. Marked
// `profiles.self_serve` so the owner can purge these independently of their
// own Laptops, and so the re-pair branch below can fail closed. Guarded only
// by a per-IP rate limit (see docs/LESSONS.md re: trusting x-forwarded-for —
// must sit behind an ingress that sets a trustworthy client IP).
export async function POST(request: Request): Promise<Response> {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rateKey = `pair:provision:${ip}`;
  const count = await redis.incr(rateKey);
  if (count === 1) {
    await redis.expire(rateKey, 3600);
  }
  if (count > RATE_LIMIT_PER_HOUR) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = await request.json().catch(() => ({}));
  const { profile_id } = body as { profile_id?: string };

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    let pid = profile_id;
    let apiKeyOut: string | undefined;

    if (pid) {
      // Re-pair path (existing Laptop, fresh phone invite only) — no new
      // laptop key minted. Scoped to self_serve Laptops ONLY: without this
      // check, anyone knowing any profile_id (including an owner's
      // admin-created Laptop) could self-mint an invite for it with no
      // ADMIN_SECRET at all. This endpoint must never touch a Laptop it did
      // not create.
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM profiles WHERE id = $1 AND self_serve = TRUE",
        [pid]
      );
      if (!existing.rows[0]) {
        await client.query("ROLLBACK");
        return Response.json({ error: "profile_not_found" }, { status: 404 });
      }
    } else {
      // Fresh provision: a self_serve Laptop + its api_key, minted directly
      // (not via the invite/claim flow). The `profile_ss_` id prefix is load
      // bearing — schema.sql's self_serve backfill keys off it.
      pid = "profile_ss_" + randomUUID().replace(/-/g, "").slice(0, 8);
      await client.query(`INSERT INTO profiles (id, name, self_serve) VALUES ($1, $2, TRUE)`, [
        pid,
        "Self-serve",
      ]);

      const userId = `usr_${randomUUID().replace(/-/g, "")}`;
      await client.query("INSERT INTO users (id) VALUES ($1)", [userId]);

      apiKeyOut = genApiKey();
      await client.query("INSERT INTO api_keys (key, user_id, profile_id) VALUES ($1, $2, $3)", [
        apiKeyOut,
        userId,
        pid,
      ]);
    }

    // Single-use, short-lived phone invite — claimed via the existing, already
    // public POST /api/pair/claim. Re-runnable independently of laptop
    // provisioning so an expired invite doesn't strand the laptop.
    const token = pairToken();
    const secretHash = hashToken(token);
    const id = inviteId();
    const expiresAt = new Date(Date.now() + PHONE_INVITE_TTL_HOURS * 3_600_000);

    await client.query(
      `INSERT INTO invites
         (id, profile_id, token, secret_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, 'active', $5)`,
      [id, pid, token, secretHash, expiresAt]
    );

    await client.query("COMMIT");

    return Response.json({
      profile_id: pid,
      ...(apiKeyOut ? { api_key: apiKeyOut } : {}),
      token,
      expires_at: expiresAt.toISOString(),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("provision POST:", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  } finally {
    client.release();
  }
}
