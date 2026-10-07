// Generated from expo-hermes; edit the private source, not this mirror.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { Client } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Override shell env so .env DATABASE_URL wins over ~/.zshrc
config({ override: true });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set — copy .env.example to .env");
  process.exit(1);
}

const sql = readFileSync(join(__dirname, "schema.sql"), "utf-8");

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// NOTE: do NOT drop the schema here. This runs as a K8s initContainer on every
// deploy — a `DROP SCHEMA public CASCADE` wipes all prod data (tenants,
// profiles, api_keys, invites) on each rollout. schema.sql is idempotent via
// `CREATE TABLE IF NOT EXISTS`, so re-runs are safe and non-destructive.
// Additive schema changes must be expressed as `ALTER TABLE ... IF NOT EXISTS`
// (or a real numbered-migration system) — never by recreating the schema.

// pg doesn't support multi-statement queries reliably — split on ";" and run each.
const statements = sql
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);
for (const stmt of statements) {
  await client.query(stmt);
}

await client.end();

console.log("Migration complete.");
