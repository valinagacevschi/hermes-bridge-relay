// Generated from expo-hermes; edit the private source, not this mirror.
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  categoryFor,
  EVENT_MAX_SKEW_MS,
  isFreshTimestamp,
  sanitizeEventData,
  templateFor,
  verifyEventSignature,
} from "@/lib/relay-events";

function sign(key: string, body: string): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

describe("categoryFor", () => {
  it("maps known event types to their category", () => {
    expect(categoryFor("run.completed")).toBe("turn_complete");
    expect(categoryFor("run.error")).toBe("error");
    expect(categoryFor("approval.request")).toBe("approval_needed");
    expect(categoryFor("write.staged")).toBe("approval_needed");
    expect(categoryFor("bot.completed")).toBe("turn_complete");
  });

  it("returns null for an unknown event type", () => {
    expect(categoryFor("agent.idle")).toBeNull();
    expect(categoryFor("")).toBeNull();
  });
});

describe("templateFor", () => {
  it("returns a generic, content-free title/body per category", () => {
    for (const category of ["turn_complete", "approval_needed", "error"] as const) {
      const t = templateFor(category);
      expect(typeof t.title).toBe("string");
      expect(typeof t.body).toBe("string");
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(0);
    }
  });
});

describe("isFreshTimestamp", () => {
  const now = 1_700_000_000_000;

  it("accepts a timestamp within the skew window", () => {
    expect(isFreshTimestamp(now, now)).toBe(true);
    expect(isFreshTimestamp(now - EVENT_MAX_SKEW_MS, now)).toBe(true);
    expect(isFreshTimestamp(now + EVENT_MAX_SKEW_MS, now)).toBe(true);
  });

  it("rejects a timestamp outside the skew window", () => {
    expect(isFreshTimestamp(now - EVENT_MAX_SKEW_MS - 1, now)).toBe(false);
    expect(isFreshTimestamp(now + EVENT_MAX_SKEW_MS + 1, now)).toBe(false);
  });

  it("rejects non-numeric or missing ts", () => {
    expect(isFreshTimestamp(undefined, now)).toBe(false);
    expect(isFreshTimestamp("1700000000000", now)).toBe(false);
    expect(isFreshTimestamp(Number.NaN, now)).toBe(false);
  });
});

describe("verifyEventSignature", () => {
  const body = JSON.stringify({ profile_id: "p1", event_type: "run.completed", ts: 123 });

  it("accepts a valid signature from one of the profile's api keys", () => {
    const sig = sign("hb_key2", body);
    expect(verifyEventSignature(["hb_key1", "hb_key2"], body, sig)).toBe(true);
  });

  it("rejects a signature that doesn't match any key on file", () => {
    const sig = sign("hb_wrongkey", body);
    expect(verifyEventSignature(["hb_key1", "hb_key2"], body, sig)).toBe(false);
  });

  it("rejects a signature computed over a different body (tampering)", () => {
    const sig = sign("hb_key1", body);
    const tampered = JSON.stringify({ profile_id: "p1", event_type: "run.error", ts: 123 });
    expect(verifyEventSignature(["hb_key1"], tampered, sig)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyEventSignature(["hb_key1"], body, null)).toBe(false);
  });

  it("rejects a malformed signature header (no sha256= prefix)", () => {
    expect(verifyEventSignature(["hb_key1"], body, "deadbeef")).toBe(false);
  });

  it("rejects when there are no api keys to check against", () => {
    const sig = sign("hb_key1", body);
    expect(verifyEventSignature([], body, sig)).toBe(false);
  });
});

describe("sanitizeEventData", () => {
  it("passes through allowlisted string/number keys", () => {
    expect(sanitizeEventData({ screen: "agent", tab: "runs", run_id: "r1" })).toEqual({
      screen: "agent",
      tab: "runs",
      run_id: "r1",
    });
  });

  it("drops keys outside the allowlist", () => {
    expect(sanitizeEventData({ screen: "agent", summary: "leaked content" })).toEqual({
      screen: "agent",
    });
  });

  it("drops category/event_type even if the caller supplies them — server sets those", () => {
    expect(
      sanitizeEventData({ category: "error", event_type: "run.error", screen: "chat" })
    ).toEqual({ screen: "chat" });
  });

  it("drops non-string/number values (objects, arrays, null)", () => {
    expect(sanitizeEventData({ screen: { nested: true }, tab: ["a"], run_id: null })).toEqual({});
  });

  it("returns an empty object for missing/non-object data", () => {
    expect(sanitizeEventData(undefined)).toEqual({});
    expect(sanitizeEventData(null)).toEqual({});
    expect(sanitizeEventData("not an object")).toEqual({});
  });
});
