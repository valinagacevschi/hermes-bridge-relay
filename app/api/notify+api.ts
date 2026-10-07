// Generated from expo-hermes; edit the private source, not this mirror.
import db from "@/lib/db";
import redis from "@/lib/redis";

type NotifyBody = {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
};

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

  let body: NotifyBody;
  try {
    body = (await request.json()) as NotifyBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const payload = JSON.stringify({ profile_id, ...body });
  await redis.publish(`hermes:${profile_id}:notify`, payload);

  return Response.json({ ok: true });
}
