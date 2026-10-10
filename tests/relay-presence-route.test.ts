// Generated from expo-hermes; edit the private source, not this mirror.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();
vi.mock("@/lib/db", () => ({ default: { query: mockDbQuery } }));
const mockCall = vi.fn();
const mockGet = vi.fn();
vi.mock("@/lib/redis", () => ({ default: { call: mockCall, get: mockGet } }));

const { GET } = await import("@/app/api/relay/presence/[profile_id]+api");

function request(profileId: string, key = "hb_key") {
  return new Request(`https://relay.test/api/relay/presence/${profileId}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
}

describe("GET /api/relay/presence/[profile_id]", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    mockCall.mockReset();
    mockGet.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [{ profile_id: "p1" }] });
    mockCall.mockResolvedValue(["hermes:p1:in", 1]);
    mockGet.mockResolvedValue("2026-10-07T09:00:00.000Z");
  });

  it("returns online status and last-seen for the owning Laptop key", async () => {
    const response = await GET(request("p1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      online: true,
      last_seen_at: "2026-10-07T09:00:00.000Z",
      checked_at: expect.any(String),
    });
    expect(mockCall).toHaveBeenCalledWith("PUBSUB", "NUMSUB", "hermes:p1:in");
    expect(mockGet).toHaveBeenCalledWith("hermes:p1:last_seen");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports offline from a zero subscriber count and null last-seen", async () => {
    mockCall.mockResolvedValue(["hermes:p1:in", 0]);
    mockGet.mockResolvedValue(null);
    const response = await GET(request("p1"));
    expect(await response.json()).toMatchObject({ online: false, last_seen_at: null });
  });

  it("rejects another Laptop's key with 403", async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ profile_id: "p2" }] });
    expect((await GET(request("p1"))).status).toBe(403);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it("rejects an unknown key with 401", async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });
    expect((await GET(request("p1"))).status).toBe(401);
    expect(mockCall).not.toHaveBeenCalled();
  });
});
