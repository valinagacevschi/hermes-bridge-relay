// Generated from expo-hermes; edit the private source, not this mirror.
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { apiKey as genApiKey } from "@/lib/tokens";

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const { token, device_id, push_token } = body as {
    token?: string;
    device_id?: string;
    push_token?: string;
  };

  if (!token) {
    return Response.json({ error: "token_required" }, { status: 400 });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query<{
      id: string;
      profile_id: string;
      status: string;
      expires_at: Date;
    }>(
      `SELECT id, profile_id, status, expires_at
       FROM invites WHERE token = $1 FOR UPDATE`,
      [token]
    );

    const invite = result.rows[0];
    if (!invite) {
      await client.query("ROLLBACK");
      return Response.json({ error: "invite_not_found" }, { status: 404 });
    }
    if (invite.status !== "active") {
      await client.query("ROLLBACK");
      return Response.json({ error: `invite_${invite.status}` }, { status: 410 });
    }
    if (new Date(invite.expires_at) < new Date()) {
      await client.query("UPDATE invites SET status = 'expired' WHERE id = $1", [invite.id]);
      await client.query("COMMIT");
      return Response.json({ error: "invite_expired" }, { status: 410 });
    }
    // Single-use is enforced by the status guard above: this claim sets status
    // to 'claimed' unconditionally, so a second attempt fails as invite_claimed.
    // auto-create anonymous user for PoC (no real auth)
    const userId = `usr_${randomUUID().replace(/-/g, "")}`;
    await client.query("INSERT INTO users (id) VALUES ($1)", [userId]);

    const key = genApiKey();
    await client.query(
      "INSERT INTO api_keys (key, user_id, profile_id, device_id) VALUES ($1, $2, $3, $4)",
      [key, userId, invite.profile_id, device_id ?? null]
    );

    await client.query(
      `UPDATE invites
       SET status = 'claimed',
           claimed_at = NOW(), claimed_by_user_id = $1, claimed_by_device_id = $2
       WHERE id = $3`,
      [userId, device_id ?? null, invite.id]
    );

    if (push_token) {
      // Append, don't overwrite — a profile can have multiple paired phones.
      await client.query(
        "UPDATE profiles SET expo_push_tokens = array_append(expo_push_tokens, $1) WHERE id = $2 AND NOT ($1 = ANY(expo_push_tokens))",
        [push_token, invite.profile_id]
      );
    }

    const profileResult = await client.query<{ name: string }>(
      "SELECT name FROM profiles WHERE id = $1",
      [invite.profile_id]
    );

    await client.query("COMMIT");

    return Response.json({
      api_key: key,
      profile_id: invite.profile_id,
      profile_name: profileResult.rows[0]?.name,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("claim POST:", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  } finally {
    client.release();
  }
}
