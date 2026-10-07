// Generated from expo-hermes; edit the private source, not this mirror.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRedisIncr = vi.fn();
const mockRedisExpire = vi.fn();
const mockDbConnect = vi.fn();

vi.mock("@/lib/redis", () => ({
  default: { incr: mockRedisIncr, expire: mockRedisExpire },
}));
vi.mock("@/lib/db", () => ({ default: { connect: mockDbConnect } }));

const { POST } = await import("@/app/api/pair/provision+api");

function request(ip?: string): Request {
  return new Request("http://localhost/api/pair/provision", {
    method: "POST",
    headers: ip ? { "x-forwarded-for": ip } : {},
    body: "{}",
  });
}

describe("POST /api/pair/provision", () => {
  beforeEach(() => {
    mockRedisIncr.mockReset();
    mockRedisExpire.mockReset();
    mockDbConnect.mockReset();
  });

  it("limits the sixth provisioning code request per IP in an hour", async () => {
    mockRedisIncr.mockResolvedValue(6);

    const response = await POST(request("203.0.113.10"));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
    expect(mockRedisIncr).toHaveBeenCalledWith("pair:provision:203.0.113.10");
    expect(mockRedisExpire).not.toHaveBeenCalled();
    expect(mockDbConnect).not.toHaveBeenCalled();
  });

  it("uses a separate fixed window key for each client IP", async () => {
    mockRedisIncr.mockResolvedValue(1);
    mockDbConnect.mockRejectedValue(new Error("stop after rate-limit check"));

    await expect(POST(request("203.0.113.11"))).rejects.toThrow("stop after rate-limit check");

    expect(mockRedisIncr).toHaveBeenCalledWith("pair:provision:203.0.113.11");
    expect(mockRedisExpire).toHaveBeenCalledWith("pair:provision:203.0.113.11", 3600);
  });
});
