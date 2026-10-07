// Generated from expo-hermes; edit the private source, not this mirror.
import db from "./db";

export function requireAdmin(request: Request): Response | null {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    console.error("ADMIN_SECRET not configured");
    return Response.json({ error: "misconfigured" }, { status: 500 });
  }
  if (request.headers.get("Authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function requireApiKey(
  request: Request,
  profile_id: string
): Promise<Response | null> {
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
  if (rows[0].profile_id !== profile_id) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}
