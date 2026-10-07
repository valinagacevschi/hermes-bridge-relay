// Generated from expo-hermes; edit the private source, not this mirror.
import { requireApiKey } from "@/lib/auth";
import db from "@/lib/db";

/**
 * Fetch a sealed blob (PRD_Features.md §2.3). The owning profile_id isn't
 * known from the URL alone, so it's looked up from the row FIRST, then
 * checked against the caller's api_key via the normal requireApiKey path —
 * same auth guarantee as every other relay endpoint, just resolved in a
 * different order.
 *
 * Response: raw sealed bytes (application/octet-stream), mime in the
 * `X-Blob-Mime` header — the body itself is opaque ciphertext, not the
 * attachment's real content-type.
 */
export async function GET(request: Request): Promise<Response> {
  // Server-rendered dynamic routes don't reliably get `params` — extract from
  // the URL directly (see docs/GOTCHAS.md).
  const blob_id = new URL(request.url).pathname.split("/").at(-1)!;

  const { rows } = await db.query<{ profile_id: string; mime: string; sealed_blob: Buffer }>(
    "SELECT profile_id, mime, sealed_blob FROM blobs WHERE blob_id = $1",
    [blob_id]
  );
  const row = rows[0];
  if (!row) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const authErr = await requireApiKey(request, row.profile_id);
  if (authErr) return authErr;

  return new Response(new Uint8Array(row.sealed_blob), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Blob-Mime": row.mime,
    },
  });
}
