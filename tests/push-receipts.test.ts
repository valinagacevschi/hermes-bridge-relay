// Generated from expo-hermes; edit the private source, not this mirror.
/**
 * Push receipt reconciliation tests — DeviceNotRegistered + BadDeviceToken prune.
 */
import { describe, expect, it } from "vitest";

import {
  BAD_DEVICE_TOKEN_REASON,
  DEAD_TOKEN_ERROR,
  type PendingTicket,
  RECEIPT_BATCH_MAX,
  RECEIPT_MAX_AGE_MS,
  RECEIPT_MIN_AGE_MS,
  interpretReceipts,
  isDeadTokenError,
  isDeadTokenReceipt,
  planReceiptSweep,
} from "@/lib/push-receipts";

const NOW = 1_800_000_000_000;

function ticket(sentAt: number, over: Partial<PendingTicket> = {}): PendingTicket {
  return { profileId: "profile_default", token: "ExponentPushToken[a]", sentAt, ...over };
}

describe("planReceiptSweep", () => {
  it("skips tickets too fresh to have a receipt yet", () => {
    // Asking immediately just returns an absent receipt, which would look
    // indistinguishable from a lost one.
    const pending = new Map([["t1", ticket(NOW - 1_000)]]);
    expect(planReceiptSweep(pending, NOW)).toEqual({ query: [], abandon: [] });
  });

  it("queries a ticket once it is old enough", () => {
    const pending = new Map([["t1", ticket(NOW - RECEIPT_MIN_AGE_MS)]]);
    expect(planReceiptSweep(pending, NOW).query).toEqual(["t1"]);
  });

  it("abandons a ticket that never got a verdict, so the map cannot grow forever", () => {
    const pending = new Map([["old", ticket(NOW - RECEIPT_MAX_AGE_MS - 1)]]);
    const plan = planReceiptSweep(pending, NOW);
    expect(plan.abandon).toEqual(["old"]);
    expect(plan.query).toEqual([]);
  });

  it("caps a batch so a backlog cannot exceed Expo's per-call limit", () => {
    const pending = new Map<string, PendingTicket>();
    for (let i = 0; i < RECEIPT_BATCH_MAX + 50; i++) {
      pending.set(`t${i}`, ticket(NOW - RECEIPT_MIN_AGE_MS));
    }
    expect(planReceiptSweep(pending, NOW).query).toHaveLength(RECEIPT_BATCH_MAX);
  });
});

describe("isDeadTokenError", () => {
  it("treats DeviceNotRegistered as dead", () => {
    expect(isDeadTokenError(DEAD_TOKEN_ERROR)).toBe(true);
  });

  it("treats APNs BadDeviceToken (DeveloperError) as dead", () => {
    // Live failure mode: ticket accepted, receipt error DeveloperError +
    // apns.reason BadDeviceToken. Leaving that token as last-wins permanently
    // silenced notify for profiles that still had healthy older tokens.
    expect(
      isDeadTokenError("DeveloperError", {
        error: "DeveloperError",
        apns: { reason: BAD_DEVICE_TOKEN_REASON },
      })
    ).toBe(true);
    expect(
      isDeadTokenError(
        "DeveloperError",
        { error: "DeveloperError" },
        `APNs failed (${BAD_DEVICE_TOKEN_REASON})`
      )
    ).toBe(true);
    expect(
      isDeadTokenReceipt({
        status: "error",
        details: { apns: { reason: BAD_DEVICE_TOKEN_REASON } },
      })
    ).toBe(true);
  });

  it("does NOT treat other DeveloperError / transient codes as dead", () => {
    expect(isDeadTokenError("DeveloperError", { error: "DeveloperError" }, "something else")).toBe(
      false
    );
    expect(isDeadTokenError("MessageRateExceeded")).toBe(false);
    expect(isDeadTokenError("InvalidCredentials")).toBe(false);
  });
});

describe("interpretReceipts", () => {
  it("prunes the token on DeviceNotRegistered — the case ticket-only checking missed", () => {
    const pending = new Map([["t1", ticket(NOW, { token: "ExponentPushToken[dead]" })]]);
    const v = interpretReceipts(
      { t1: { status: "error", message: "not registered", details: { error: DEAD_TOKEN_ERROR } } },
      ["t1"],
      pending
    );
    expect(v.dead).toEqual([
      {
        ticketId: "t1",
        profileId: "profile_default",
        token: "ExponentPushToken[dead]",
        error: DEAD_TOKEN_ERROR,
      },
    ]);
    expect(v.failed).toEqual([]);
  });

  it("prunes on BadDeviceToken DeveloperError — last-wins notify would otherwise stick on it", () => {
    const pending = new Map([["t1", ticket(NOW, { token: "ExponentPushToken[bad]" })]]);
    const v = interpretReceipts(
      {
        t1: {
          status: "error",
          message: `The Apple Push Notification service failed (reason: ${BAD_DEVICE_TOKEN_REASON})`,
          details: {
            error: "DeveloperError",
            apns: { reason: BAD_DEVICE_TOKEN_REASON, statusCode: 400 },
          },
        },
      },
      ["t1"],
      pending
    );
    expect(v.dead).toEqual([
      {
        ticketId: "t1",
        profileId: "profile_default",
        token: "ExponentPushToken[bad]",
        error: "DeveloperError",
      },
    ]);
    expect(v.failed).toEqual([]);
  });

  it("does NOT prune on a transient error", () => {
    // MessageRateExceeded / MessageTooBig / InvalidCredentials are faults to
    // log, not reasons to unregister a working device.
    const pending = new Map([["t1", ticket(NOW)]]);
    const v = interpretReceipts(
      { t1: { status: "error", details: { error: "MessageRateExceeded" } } },
      ["t1"],
      pending
    );
    expect(v.dead).toEqual([]);
    expect(v.failed[0]?.error).toBe("MessageRateExceeded");
  });

  it("treats a missing receipt as unresolved, never as delivered", () => {
    // The whole point of this module: silence must not be read as success.
    const pending = new Map([["t1", ticket(NOW)]]);
    const v = interpretReceipts({}, ["t1"], pending);
    expect(v.unresolved).toEqual(["t1"]);
    expect(v.delivered).toEqual([]);
  });

  it("treats a malformed receipt as unresolved rather than guessing", () => {
    const pending = new Map([["t1", ticket(NOW)]]);
    const v = interpretReceipts({ t1: {} }, ["t1"], pending);
    expect(v.unresolved).toEqual(["t1"]);
  });

  it("handles a null response body without throwing", () => {
    const pending = new Map([["t1", ticket(NOW)]]);
    expect(interpretReceipts(null, ["t1"], pending).unresolved).toEqual(["t1"]);
  });

  it("confirms delivery on ok", () => {
    const pending = new Map([["t1", ticket(NOW)]]);
    const v = interpretReceipts({ t1: { status: "ok" } }, ["t1"], pending);
    expect(v.delivered).toEqual(["t1"]);
    expect(v.dead).toEqual([]);
  });

  it("sorts a mixed batch into the right buckets", () => {
    const pending = new Map([
      ["ok1", ticket(NOW)],
      ["dead1", ticket(NOW, { token: "ExponentPushToken[d]", profileId: "p2" })],
      ["bad1", ticket(NOW)],
      ["gone1", ticket(NOW)],
    ]);
    const v = interpretReceipts(
      {
        ok1: { status: "ok" },
        dead1: { status: "error", details: { error: DEAD_TOKEN_ERROR } },
        bad1: { status: "error", details: { error: "MessageTooBig" } },
      },
      ["ok1", "dead1", "bad1", "gone1"],
      pending
    );
    expect(v.delivered).toEqual(["ok1"]);
    expect(v.dead.map((d) => d.profileId)).toEqual(["p2"]);
    expect(v.failed.map((f) => f.error)).toEqual(["MessageTooBig"]);
    expect(v.unresolved).toEqual(["gone1"]);
  });

  it("cannot prune a token it has no record of", () => {
    // A dead verdict for an unknown ticket must not produce a prune with a
    // guessed profile/token.
    const v = interpretReceipts(
      { t1: { status: "error", details: { error: DEAD_TOKEN_ERROR } } },
      ["t1"],
      new Map()
    );
    expect(v.dead).toEqual([]);
    expect(v.failed[0]?.profileId).toBe("unknown");
  });
});
