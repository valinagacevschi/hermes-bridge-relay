// Generated from expo-hermes; edit the private source, not this mirror.
import { type IncomingMessage, type ServerResponse, createServer } from "http";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

import Redis from "ioredis";
import { Pool } from "pg";

config({ override: true });

// Last-resort backstop: log and keep running instead of a hard crash. Every
// known error source above (Redis, pg, this HTTP server) already has its own
// handler — this only catches something none of them anticipated, so this
// process doesn't crash-loop and drop every open SSE connection over it.
process.on("uncaughtException", (err) => console.error("[relay-http] uncaught exception:", err));
process.on("unhandledRejection", (err) => console.error("[relay-http] unhandled rejection:", err));

// expo-server's ESM build has extensionless internal imports Node.js ESM rejects.
// Force CJS load to use the require() condition which resolves them correctly.
const require = createRequire(import.meta.url);
const { createRequestHandler } = require("expo-server/adapter/http");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REDIS_URL = process.env.REDIS_URL!;
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
// See lib/db.ts — an unhandled pg.Pool "error" event is fatal to the process.
pool.on("error", (err) => console.error("[relay-http] pg pool error:", err));

const handler = createRequestHandler({
  build: join(__dirname, "../dist/server"),
});

async function authorizeApiKey(req: IncomingMessage, profile_id: string): Promise<boolean> {
  const auth = req.headers["authorization"] ?? "";
  if (!auth.startsWith("Bearer hb_")) return false;
  const key = auth.slice("Bearer ".length);
  const { rows } = await pool.query("SELECT 1 FROM api_keys WHERE key = $1 AND profile_id = $2", [
    key,
    profile_id,
  ]);
  return rows.length > 0;
}

// expo-server/adapter/http buffers the full response body before sending headers,
// so SSE streams (which never close) produce zero bytes through nginx.
// Handle SSE paths directly in Node.js to stream immediately.
async function handleSSE(req: IncomingMessage, res: ServerResponse) {
  const m = req.url!.match(/^\/api\/relay\/stream\/([^/?]+)/);
  if (!m) {
    res.writeHead(400);
    res.end();
    return;
  }
  const profile_id = m[1];

  const authed = await authorizeApiKey(req, profile_id);
  if (!authed) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // Disable Nagle's algorithm so small SSE chunks flush immediately over the network.
  req.socket?.setNoDelay(true);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const sub = new Redis(REDIS_URL);
  // Without this, ioredis emits an unhandled "error" event on any transient
  // connection blip, which Node treats as an uncaught exception and crashes
  // the whole process — killing every open SSE connection at once.
  sub.on("error", (err) => console.error("[relay-http] redis error:", err));
  sub.subscribe(`hermes:${profile_id}:out`);
  sub.on("message", (_, msg) => res.write(`data: ${msg}\n\n`));

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sub.unsubscribe().then(() => sub.quit());
  });
}

const port = Number(process.env.PORT ?? 3000);

const httpServer = createServer((req, res) => {
  if (req.url?.startsWith("/api/relay/stream/")) {
    handleSSE(req, res).catch((err) => {
      console.error("[relay-http] SSE error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
    return;
  }
  handler(req, res, () => {});
});
httpServer.on("error", (err) => console.error("[relay-http] server error:", err));
httpServer.listen(port, () => {
  console.log(`[relay-http] listening on port ${port}`);
});
