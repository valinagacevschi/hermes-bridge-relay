// Generated from expo-hermes; edit the private source, not this mirror.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock db + redis before the route module loads. Unlike relay-events-route.test.ts,
// enqueue needs a db.connect() client for the advisory-locked seq allocation.
const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
vi.mock("@/lib/db", () => ({
  default: {
    query: mockDbQuery,
    connect: async () => ({ query: mockClientQuery, release: mockRelease }),
  },
}));

const mockRedisPublish = vi.fn();
vi.mock("@/lib/redis", () => ({ default: { publish: mockRedisPublish } }));

const { POST } = await import("@/app/api/relay/enqueue+api");

const PROFILE_ID = "p1";
const API_KEY = "hb_test_key";
const MSG_ID = "m1";
const FRAME = "sealed-base64";
const PROFILE_NAME = "work-macbook";

/** `existingSeq` non-null makes the msg_id look already-enqueued. */
function stubClient(existingSeq: number | null) {
  mockClientQuery.mockImplementation(async (sql: string) => {
    if (/SELECT seq FROM messages WHERE profile_id/.test(sql)) {
      return { rows: existingSeq === null ? [] : [{ seq: String(existingSeq) }] };
    }
    if (/COALESCE\(MAX\(seq\)/.test(sql)) return { rows: [{ next: "7" }] };
    return { rows: [] }; // BEGIN/COMMIT/lock/INSERT/DELETE-eviction
  });
}

function makeRequest(body: unknown, auth = `Bearer ${API_KEY}`): Request {
  return new Request("http://localhost/api/relay/enqueue", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { Authorization: auth },
  });
}

function notifyPayloads() {
  return mockRedisPublish.mock.calls
    .filter(([channel]) => String(channel).endsWith(":notify"))
    .map(([, raw]) => JSON.parse(raw as string));
}

describe("POST /api/relay/enqueue", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockRelease.mockReset();
    mockRedisPublish.mockReset();
    mockDbQuery.mockResolvedValue({
      rows: [{ profile_id: PROFILE_ID, profile_name: PROFILE_NAME }],
    });
    mockRedisPublish.mockResolvedValue(1);
    stubClient(null);
  });

  it("adds a tap destination to the push it already sends, without a second push", async () => {
    const res = await POST(
      makeRequest({ msg_id: MSG_ID, sealed_frame: FRAME, category: "turn_complete" })
    );
    expect(res.status).toBe(200);

    const pushes = notifyPayloads();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].data.category).toBe("turn_complete");
    expect(pushes[0].data.screen).toBe("chat");
    expect(pushes[0].data.profile_id).toBe(PROFILE_ID);
    expect(mockRedisPublish).toHaveBeenCalledWith(`hermes:${PROFILE_ID}:out`, FRAME);
  });

  it("uses the relay-known laptop name without exposing message content", async () => {
    // The adapter tags every reply, so a "turn finished" body would fire once
    // per send of a multi-send turn.
    await POST(makeRequest({ msg_id: "a", sealed_frame: FRAME, category: "turn_complete" }));
    await POST(makeRequest({ msg_id: "b", sealed_frame: FRAME, category: "turn_complete" }));

    const pushes = notifyPayloads();
    expect(pushes).toHaveLength(2);
    expect(pushes.map((p) => p.body)).toEqual([
      "New message from work-macbook",
      "New message from work-macbook",
    ]);
    expect(JSON.stringify(pushes)).not.toContain(FRAME);
    expect(mockDbQuery).toHaveBeenCalledWith(expect.stringContaining("JOIN profiles"), [API_KEY]);
  });

  it("uses the laptop name and no routing hint when no category is sent", async () => {
    const res = await POST(makeRequest({ msg_id: MSG_ID, sealed_frame: FRAME }));
    expect(res.status).toBe(200);

    const pushes = notifyPayloads();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body).toBe("New message from work-macbook");
    expect(pushes[0].data.category).toBeUndefined();
    expect(pushes[0].data.screen).toBeUndefined();
  });

  it("does not let a caller claim a category this path may not use", async () => {
    // A gateway holding the profile's hb_ key must not pick its own destination.
    const res = await POST(makeRequest({ msg_id: MSG_ID, sealed_frame: FRAME, category: "error" }));
    expect(res.status).toBe(200);

    const pushes = notifyPayloads();
    expect(pushes[0].data.category).toBeUndefined();
    expect(pushes[0].data.screen).toBeUndefined();
  });

  it("does not push again for a retried POST of a msg_id already on file", async () => {
    stubClient(3);
    const res = await POST(
      makeRequest({ msg_id: MSG_ID, sealed_frame: FRAME, category: "turn_complete" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, seq: 3 });

    expect(notifyPayloads()).toHaveLength(0);
    expect(mockRedisPublish).toHaveBeenCalledWith(`hermes:${PROFILE_ID}:out`, FRAME);
  });

  it("rejects a non-hb_ Authorization header without touching the pool", async () => {
    const res = await POST(makeRequest({ msg_id: MSG_ID, sealed_frame: FRAME }, "Bearer nope"));
    expect(res.status).toBe(401);
    expect(mockRedisPublish).not.toHaveBeenCalled();
  });

  it("requires msg_id and sealed_frame", async () => {
    const res = await POST(makeRequest({ msg_id: MSG_ID }));
    expect(res.status).toBe(400);
    expect(mockRedisPublish).not.toHaveBeenCalled();
  });
});
