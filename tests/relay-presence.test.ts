// Generated from expo-hermes; edit the private source, not this mirror.
import { describe, expect, it, vi } from "vitest";

import {
  createHeartbeatMonitor,
  createLastSeenTracker,
  LAST_SEEN_TTL_SECONDS,
  writeLastSeen,
} from "@/lib/relay-presence";

describe("relay presence helpers", () => {
  it("writes rounded ISO last-seen with a 30-day TTL", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    await writeLastSeen({ set }, "p1", new Date("2026-10-07T09:42:53.123Z"));
    expect(set).toHaveBeenCalledWith(
      "hermes:p1:last_seen",
      "2026-10-07T09:42:00.000Z",
      "EX",
      LAST_SEEN_TTL_SECONDS
    );
  });

  it("writes on connect and close, throttling pong writes to once per minute", async () => {
    const set = vi.fn().mockResolvedValue("OK");
    let now = new Date("2026-10-07T09:42:10.000Z");
    const tracker = createLastSeenTracker({ set }, "p1", () => now);
    await tracker.connect();
    await tracker.pong();
    now = new Date("2026-10-07T09:43:10.000Z");
    await tracker.pong();
    now = new Date("2026-10-07T09:43:50.000Z");
    await tracker.pong();
    now = new Date("2026-10-07T09:44:10.000Z");
    await tracker.pong();
    await tracker.close();
    expect(set).toHaveBeenCalledTimes(4);
    expect(set).toHaveBeenNthCalledWith(1, "hermes:p1:last_seen", "2026-10-07T09:42:00.000Z", "EX", 2592000);
    expect(set).toHaveBeenNthCalledWith(2, "hermes:p1:last_seen", "2026-10-07T09:43:00.000Z", "EX", 2592000);
    expect(set).toHaveBeenNthCalledWith(3, "hermes:p1:last_seen", "2026-10-07T09:44:00.000Z", "EX", 2592000);
    expect(set).toHaveBeenNthCalledWith(4, "hermes:p1:last_seen", "2026-10-07T09:44:00.000Z", "EX", 2592000);
  });

  it("swallows Redis write failures and keeps pong throttling active", async () => {
    const set = vi.fn().mockRejectedValue(new Error("redis unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = new Date("2026-10-07T09:42:10.000Z");
    const tracker = createLastSeenTracker({ set }, "p1", () => now);

    await expect(tracker.connect()).resolves.toBeUndefined();
    await expect(tracker.pong()).resolves.toBeUndefined();
    await expect(tracker.close()).resolves.toBeUndefined();
    expect(set).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("[ws] last_seen write failed: p1");

    now = new Date("2026-10-07T09:43:10.000Z");
    await tracker.pong();
    expect(set).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("terminates after two missed pong intervals, but not one", () => {
    const ping = vi.fn();
    const terminate = vi.fn();
    const heartbeat = createHeartbeatMonitor({ ping, terminate });
    heartbeat.tick(); // first ping
    heartbeat.tick(); // one missed pong
    expect(terminate).not.toHaveBeenCalled();
    heartbeat.tick(); // two consecutive misses
    expect(terminate).toHaveBeenCalledOnce();
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("resets consecutive misses when a pong arrives", () => {
    const terminate = vi.fn();
    const heartbeat = createHeartbeatMonitor({ ping: vi.fn(), terminate });
    heartbeat.tick();
    heartbeat.tick();
    heartbeat.pong();
    heartbeat.tick();
    expect(terminate).not.toHaveBeenCalled();
  });
});
