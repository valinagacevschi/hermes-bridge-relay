// Generated from expo-hermes; edit the private source, not this mirror.
import { describe, expect, it } from "vitest";

import { pickNotifyToken } from "@/lib/push-targeting";

describe("pickNotifyToken", () => {
  it("returns undefined with no paired devices", () => {
    expect(pickNotifyToken([])).toBeUndefined();
  });

  it("picks the sole token for a single paired device", () => {
    expect(pickNotifyToken(["a"])).toBe("a");
  });

  it("picks the most recently (re-)paired device, not every device", () => {
    expect(pickNotifyToken(["a", "b", "c"])).toBe("c");
  });
});
