// Generated from expo-hermes; edit the private source, not this mirror.
/**
 * Signed lifecycle events (#44): the gateway POSTs a content-free lifecycle
 * event (a run finished, an approval is needed, something errored) to
 * `POST /api/relay/events`, HMAC-signed with the profile's existing `hb_`
 * api_key — no new secret. This module holds the pure, testable logic; the
 * route (app/api/relay/events+api.ts) is a thin wire-up around it.
 *
 * Scope note (issue #44 correction, posted as a GitLab issue note before
 * this was built): this replaces the plaintext, unsigned, any-key
 * `_send_push_notification` → `/api/notify` path for the 4 sites that used
 * it (run.completed/run.error/approval.request/write.staged). It does NOT
 * touch the existing `enqueue+api.ts` chat-message push or the deep-link
 * routing decision — both deferred to a follow-up issue, since AC1
 * ("exactly one push per turn") isn't achievable without also fixing a
 * pre-existing #41 characteristic (a turn calling send() more than once
 * already produces more than one push) that is out of scope here.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type EventType =
  | "run.completed"
  | "run.error"
  | "approval.request"
  | "write.staged"
  | "bot.completed";
export type EventCategory = "turn_complete" | "approval_needed" | "error";

// Server-authoritative: the adapter names WHAT happened (event_type), never
// the push category directly — so a compromised or buggy gateway can't pick
// an arbitrary category (e.g. label a routine event "error" to force a
// higher-attention notification style). Unknown event_type is rejected by
// the route, not defaulted to a category.
const EVENT_CATEGORY: Record<EventType, EventCategory> = {
  "run.completed": "turn_complete",
  "run.error": "error",
  "approval.request": "approval_needed",
  "write.staged": "approval_needed",
  "bot.completed": "turn_complete",
};

// Generic, content-free templates — payloads never carry message content
// (no run description, no memory/skill summary), preserving the
// zero-knowledge posture. The relay is the only place that knows what a
// category "means" in human terms.
const TEMPLATES: Record<EventCategory, { title: string; body: string }> = {
  turn_complete: { title: "Hermes", body: "Agent turn finished." },
  approval_needed: { title: "Hermes", body: "Your approval is needed." },
  error: { title: "Hermes", body: "Something went wrong." },
};

const BOT_COMPLETED_TEMPLATE = { title: "Hermes", body: "A Bot finished a turn." };

export function categoryFor(eventType: string): EventCategory | null {
  return (EVENT_CATEGORY as Record<string, EventCategory | undefined>)[eventType] ?? null;
}

export function templateFor(
  category: EventCategory,
  eventType?: string
): { title: string; body: string } {
  if (eventType === "bot.completed") return BOT_COMPLETED_TEMPLATE;
  return TEMPLATES[category];
}

// Server-side allowlist for the adapter-supplied `data` field (code-review
// finding, #44): the "content-free" guarantee can't rest on trusting every
// call site to only ever send routing metadata — a compromised/buggy
// gateway holding any of the profile's keys could otherwise stuff arbitrary
// free text (or an override of `category`/`event_type`) into `data` and
// have it forwarded verbatim to the device via server/push.ts. Only these
// structural routing keys, and only string/number values, survive; anything
// else (including client-supplied `category`/`event_type`) is dropped —
// the route re-adds the server-computed `category`/`event_type` afterward.
// `dest` / `event_id` are opaque Bot-completion routing (#81) — never Bot names.
const ALLOWED_DATA_KEYS = new Set(["screen", "tab", "run_id", "subsystem", "dest", "event_id"]);

export function sanitizeEventData(data: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!data || typeof data !== "object") return out;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (ALLOWED_DATA_KEYS.has(key) && (typeof value === "string" || typeof value === "number")) {
      out[key] = value;
    }
  }
  return out;
}

// Absolute epoch-ms freshness window — same absolute-not-relative reasoning
// as #42's prompt `expires_at`: the adapter stamps `ts` at send time, and the
// route rejects anything outside this skew of "now" rather than trusting a
// relative timeout, so a validly-signed-but-stale event can't be replayed
// long after the fact.
export const EVENT_MAX_SKEW_MS = 5 * 60 * 1000;

export function isFreshTimestamp(ts: unknown, now: number): boolean {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(now - ts) <= EVENT_MAX_SKEW_MS;
}

/**
 * Verify `sha256=<hex>` (the `X-Hub-Signature-256` convention Hermes core's
 * own `hermes webhook test` CLI already uses) computed as
 * HMAC-SHA256(apiKey, rawBody), tried against every api_key on file for the
 * profile. Any key valid for the profile can sign — same trust model as
 * every other relay route (message+api.ts, ws.ts): `api_keys` has no column
 * distinguishing a "gateway" key from a "device" key today, so the mobile
 * app's own key is an equally valid signer. Constant-time compare.
 */
export function verifyEventSignature(
  apiKeys: string[],
  rawBody: string,
  signatureHeader: string | null
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const providedBuf = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  for (const key of apiKeys) {
    const expectedBuf = createHmac("sha256", key).update(rawBody).digest();
    if (expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)) {
      return true;
    }
  }
  return false;
}

// Fixed-window per-profile cap (mirrors app/api/pair/provision+api.ts's
// redis INCR/EXPIRE rate limit — no new table). Deliberately well under a
// plausible "storm" burst so AC5's test can demonstrate rejection within a
// single 20-event burst.
export const EVENTS_RATE_LIMIT_PER_MINUTE = 10;
export const EVENTS_RATE_LIMIT_WINDOW_S = 60;

// Categories the chat-message push may claim (#50) — routing only, no template.
const CHAT_CATEGORIES = new Set<string>(["turn_complete"]);

export function chatCategoryFor(value: unknown): EventCategory | null {
  return typeof value === "string" && CHAT_CATEGORIES.has(value) ? (value as EventCategory) : null;
}
