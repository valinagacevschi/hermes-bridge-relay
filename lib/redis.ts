// Generated from expo-hermes; edit the private source, not this mirror.
import { config } from "dotenv";
import Redis from "ioredis";

config({ override: true });

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL not set");
}

const redis = new Redis(process.env.REDIS_URL);
// Shared by every app/api/** route — an unhandled ioredis "error" event is
// fatal to the process (Node's default EventEmitter behavior), so without
// this ANY transient Redis blip crashes the whole relay.
redis.on("error", (err) => console.error("[redis] error:", err));

export default redis;
