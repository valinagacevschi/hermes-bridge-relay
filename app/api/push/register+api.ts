// Generated from expo-hermes; edit the private source, not this mirror.
import db from "@/lib/db";

export async function POST(request: Request): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer hb_")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const key = auth.slice("Bearer ".length);

  const { rows } = await db.query<{ profile_id: string }>(
    "SELECT profile_id FROM api_keys WHERE key = $1",
    [key]
  );
  if (!rows[0]) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { profile_id } = rows[0];

  let body: { token?: string };
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) {
    return Response.json({ error: "missing_token" }, { status: 400 });
  }

  // Append, don't overwrite — a profile can have multiple paired phones.
  // Dedup guard: re-registering the same token (e.g. lib/push.ts
  // ensurePushTokenFresh running on every launch) must not pile up duplicates.
  await db.query(
    "UPDATE profiles SET expo_push_tokens = array_append(expo_push_tokens, $1) WHERE id = $2 AND NOT ($1 = ANY(expo_push_tokens))",
    [token, profile_id]
  );

  return Response.json({ ok: true });
}
