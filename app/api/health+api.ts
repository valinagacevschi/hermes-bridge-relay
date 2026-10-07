// Generated from expo-hermes; edit the private source, not this mirror.
import db from "@/lib/db";

export async function GET(): Promise<Response> {
  try {
    await db.query("SELECT 1");
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "degraded", db: "unreachable" }, { status: 503 });
  }
}
