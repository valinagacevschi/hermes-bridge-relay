// Generated from expo-hermes; edit the private source, not this mirror.
import { config } from "dotenv";
import { Pool } from "pg";

config({ override: true });

const db = new Pool({ connectionString: process.env.DATABASE_URL });
// Same reasoning as lib/redis.ts — pg.Pool emits "error" on a background
// (idle-client) connection failure, and an unhandled one is fatal.
db.on("error", (err) => console.error("[db] pool error:", err));

export default db;
