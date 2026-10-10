// Generated from expo-hermes; edit the private source, not this mirror.
import { config } from "dotenv";

import { requireApiKey } from "@/lib/auth";
import redis from "@/lib/redis";
import { readRelayPresence } from "@/lib/relay-presence";

config({ override: true });

export async function GET(request: Request): Promise<Response> {
  const profile_id = new URL(request.url).pathname.split("/").at(-1) ?? "";
  const authErr = await requireApiKey(request, profile_id);
  if (authErr) return authErr;

  const presence = await readRelayPresence(redis, profile_id);
  return Response.json(presence, { headers: { "Cache-Control": "no-store" } });
}
