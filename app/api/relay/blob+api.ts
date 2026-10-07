// Generated from expo-hermes; edit the private source, not this mirror.
import { randomUUID } from "node:crypto";

import { config } from "dotenv";

import { requireApiKey } from "@/lib/auth";
import db from "@/lib/db";

config({ override: true });

// Sealed (encrypted) blob size cap — comfortably covers a phone photo or a
// few-page PDF while bounding worst-case memory per request. Raw binary body
// (not base64-in-JSON) keeps this ~33% smaller on the wire and avoids parsing
// a huge JSON string just to unwrap a byte array.
const MAX_BLOB_BYTES = 15 * 1024 * 1024;

/**
 * Sealed-blob store (PRD_Features.md §2.3). Attachments (images/files/audio)
 * are stored here separately from the `messages` table so large binary
 * content never bloats the Redis-pubsub-backed durable-message row. The body
 * is the caller's already-sealed blob (lib/crypto.ts sealBlob / crypto.py
 * seal_blob) — the relay only ever stores/returns opaque ciphertext.
 *
 * Request: POST ?profile_id=<id>&mime=<mime>, Authorization: Bearer hb_...,
 * body = raw sealed bytes (application/octet-stream).
 * Response: { blob_id }
 */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const profile_id = url.searchParams.get("profile_id");
  const mime = url.searchParams.get("mime");
  if (!profile_id || !mime) {
    return Response.json({ error: "profile_id and mime required" }, { status: 400 });
  }

  const authErr = await requireApiKey(request, profile_id);
  if (authErr) return authErr;

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BLOB_BYTES) {
    return Response.json({ error: "blob_too_large" }, { status: 413 });
  }

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length === 0) {
    return Response.json({ error: "empty_body" }, { status: 400 });
  }
  if (buf.length > MAX_BLOB_BYTES) {
    return Response.json({ error: "blob_too_large" }, { status: 413 });
  }

  const blob_id = `blob_${randomUUID().replace(/-/g, "")}`;
  await db.query(
    "INSERT INTO blobs (blob_id, profile_id, mime, sealed_blob, bytes) VALUES ($1, $2, $3, $4, $5)",
    [blob_id, profile_id, mime, buf, buf.length]
  );

  return Response.json({ blob_id });
}
