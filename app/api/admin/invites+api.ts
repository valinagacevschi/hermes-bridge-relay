// Generated from expo-hermes; edit the private source, not this mirror.
import { requireAdmin } from "@/lib/auth";
import db from "@/lib/db";
import { apiKey, hashToken, inviteId, speakableToken } from "@/lib/tokens";

export async function POST(request: Request): Promise<Response> {
  const authErr = requireAdmin(request);
  if (authErr) return authErr;

  const body = await request.json().catch(() => ({}));
  const {
    profile_id,
    profile_name,
    expires_in_hours = 72,
  } = body as {
    profile_id?: string;
    profile_name?: string;
    expires_in_hours?: number;
  };

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    let pid = profile_id;
    if (!pid) {
      const name = profile_name ?? "default";

      // upsert the Laptop row
      const pResult = await client.query<{ id: string }>(
        `INSERT INTO profiles (id, name)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        ["profile_" + name.toLowerCase().replace(/\s+/g, "_"), name]
      );
      pid = pResult.rows[0].id;
    }

    const profileRow = await client.query<{ id: string }>(`SELECT id FROM profiles WHERE id = $1`, [
      pid,
    ]);
    if (!profileRow.rows[0]) {
      await client.query("ROLLBACK");
      return Response.json({ error: "profile_not_found" }, { status: 404 });
    }

    const token = speakableToken();
    const secretHash = hashToken(token);
    const id = inviteId();
    const expiresAt = new Date(Date.now() + expires_in_hours * 3_600_000);

    await client.query(
      `INSERT INTO invites
         (id, profile_id, token, secret_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, 'active', $5)`,
      [id, pid, token, secretHash, expiresAt]
    );

    await client.query("COMMIT");

    const base = process.env.PUBLIC_URL ?? "http://localhost:8081";
    return Response.json({
      invite_url: `${base}/p/${encodeURIComponent(token)}`,
      invite_code: token,
      profile_id: pid,
      expires_at: expiresAt.toISOString(),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("invites POST:", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  } finally {
    client.release();
  }
}
