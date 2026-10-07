// Generated from expo-hermes; edit the private source, not this mirror.
import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the db pool and redis client before the route module loads — the
// real modules throw/connect at import time (redis.ts throws if REDIS_URL
// is unset), same pattern as lib/__tests__/profiles-api.test.ts.
const mockDbQuery = vi.fn();
vi.mock("@/lib/db", () => ({ default: { query: mockDbQuery } }));

const mockRedisIncr = vi.fn();
const mockRedisExpire = vi.fn();
const mockRedisPublish = vi.fn();
vi.mock("@/lib/redis", () => ({
  default: { incr: mockRedisIncr, expire: mockRedisExpire, publish: mockRedisPublish },
}));

const { POST } = await import("@/app/api/relay/events+api");

const PROFILE_ID = "p1";
const API_KEY = "hb_test_key";

function sign(key: string, body: string): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

function makeRequest(body: unknown, signature?: string): Request {
  const raw = JSON.stringify(body);
  return new Request("http://localhost/api/relay/events", {
    method: "POST",
    body: raw,
    headers: signature ? { "X-Hub-Signature-256": signature } : {},
  });
}

describe("POST /api/relay/events", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    mockRedisIncr.mockReset();
    mockRedisExpire.mockReset();
    mockRedisPublish.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [{ key: API_KEY }] });
    mockRedisIncr.mockResolvedValue(1);
  });

  it("publishes a categorized, content-free push on a validly-signed event", async () => {
    const body = { profile_id: PROFILE_ID, event_type: "run.completed", ts: Date.now() };
    const res = await POST(makeRequest(body, sign(API_KEY, JSON.stringify(body))));
    expect(res.status).toBe(200);

    expect(mockRedisPublish).toHaveBeenCalledTimes(1);
    const [channel, payloadStr] = mockRedisPublish.mock.calls[0] as [string, string];
    expect(channel).toBe(`hermes:${PROFILE_ID}:notify`);
    const payload = JSON.parse(payloadStr);
    expect(payload.data.profile_id).toBe(PROFILE_ID);
    expect(payload.data.category).toBe("turn_complete");
    expect(payload.data.event_type).toBe("run.completed");
  });

  it("publishes a generic Bot completion push with opaque dest only", async () => {
    const body = {
      profile_id: PROFILE_ID,
      event_type: "bot.completed",
      ts: Date.now(),
      data: {
        screen: "bot",
        dest: "sealed-opaque",
        event_id: "abc123",
        bot: "Coder",
        content: "secret",
      },
    };
    const res = await POST(makeRequest(body, sign(API_KEY, JSON.stringify(body))));
    expect(res.status).toBe(200);
    const payload = JSON.parse(mockRedisPublish.mock.calls[0][1] as string);
    expect(payload.title).toBe("Hermes");
    expect(payload.body).toBe("A Bot finished a turn.");
    expect(payload.data.screen).toBe("bot");
    expect(payload.data.dest).toBe("sealed-opaque");
    expect(payload.data.event_id).toBe("abc123");
    expect(payload.data.bot).toBeUndefined();
    expect(payload.data.content).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("Coder");
  });

  it("does NOT let a client-supplied data.category override the server-computed category", async () => {
    // write.staged legitimately maps to approval_needed — an attacker (or a
    // buggy gateway holding any of the profile's keys) tries to force the
    // "error" category via the data field instead.
    const body = {
      profile_id: PROFILE_ID,
      event_type: "write.staged",
      ts: Date.now(),
      data: {
        category: "error",
        event_type: "run.error",
        profile_id: "attacker-profile",
        screen: "agent",
      },
    };
    const res = await POST(makeRequest(body, sign(API_KEY, JSON.stringify(body))));
    expect(res.status).toBe(200);

    const payload = JSON.parse(mockRedisPublish.mock.calls[0][1] as string);
    expect(payload.data.category).toBe("approval_needed");
    expect(payload.data.event_type).toBe("write.staged");
    expect(payload.data.profile_id).toBe(PROFILE_ID);
    expect(payload.data.screen).toBe("agent"); // legitimate routing fields still pass through
  });

  it("rejects a missing signature with 401 and does not publish", async () => {
    const body = { profile_id: PROFILE_ID, event_type: "run.completed", ts: Date.now() };
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(401);
    expect(mockRedisPublish).not.toHaveBeenCalled();
  });

  it("rejects a signature computed with the wrong key with 401", async () => {
    const body = { profile_id: PROFILE_ID, event_type: "run.completed", ts: Date.now() };
    const res = await POST(makeRequest(body, sign("hb_wrong_key", JSON.stringify(body))));
    expect(res.status).toBe(401);
    expect(mockRedisPublish).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp with 401", async () => {
    const body = {
      profile_id: PROFILE_ID,
      event_type: "run.completed",
      ts: Date.now() - 10 * 60 * 1000,
    };
    const res = await POST(makeRequest(body, sign(API_KEY, JSON.stringify(body))));
    expect(res.status).toBe(401);
    expect(mockRedisPublish).not.toHaveBeenCalled();
  });

  it("rejects an unknown event_type with 400", async () => {
    const body = { profile_id: PROFILE_ID, event_type: "agent.idle", ts: Date.now() };
    const res = await POST(makeRequest(body, sign(API_KEY, JSON.stringify(body))));
    expect(res.status).toBe(400);
    expect(mockRedisPublish).not.toHaveBeenCalled();
  });

  it("rate-limits with 429 once the per-profile window cap is exceeded", async () => {
    mockRedisIncr.mockResolvedValue(11); // over EVENTS_RATE_LIMIT_PER_MINUTE (10)
    const body = { profile_id: PROFILE_ID, event_type: "run.completed", ts: Date.now() };
    const res = await POST(makeRequest(body, sign(API_KEY, JSON.stringify(body))));
    expect(res.status).toBe(429);
    expect(mockRedisPublish).not.toHaveBeenCalled();
  });
});
