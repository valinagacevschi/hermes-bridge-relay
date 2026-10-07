// Generated from expo-hermes; edit the private source, not this mirror.
import { describe, expect, it } from "vitest";

import { allocateAndInsert, computeGap } from "@/lib/relay-queue";

describe("relay sequence allocation", () => {
  it("allocates above the eviction floor after the retained queue is emptied", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.function("GREATEST", (a, b) => Math.max(Number(a), Number(b)));
    sqlite.exec(`CREATE TABLE profiles (id TEXT, messages_floor_seq INTEGER);
      CREATE TABLE messages (profile_id TEXT, seq INTEGER, msg_id TEXT, sealed_frame TEXT);
      INSERT INTO profiles VALUES ('p1', 100);`);
    const client = {
      query: async (sql: string, params: SQLInputValue[] = []) => {
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        const bindings = Object.fromEntries(params.map((value, index) => [`$${index + 1}`, value]));
        return { rows: sqlite.prepare(sql).all(bindings) };
      },
    };
    try {
      const first = await allocateAndInsert(client as never, {
        queue: "messages",
        profileId: "p1",
        msgId: "m1",
        sealedFrame: "test",
      });
      expect(first).toEqual({ seq: 101, isNew: true });
      const duplicate = await allocateAndInsert(client as never, {
        queue: "messages",
        profileId: "p1",
        msgId: "m1",
        sealedFrame: "test",
      });
      expect(duplicate).toEqual({ seq: 101, isNew: false });
      sqlite.exec("DELETE FROM messages; UPDATE profiles SET messages_floor_seq = 101;");
      const next = await allocateAndInsert(client as never, {
        queue: "messages",
        profileId: "p1",
        msgId: "m2",
        sealedFrame: "test",
      });
      expect(next.seq).toBe(102);
    } finally {
      sqlite.close();
    }
  });
});

describe("computeGap", () => {
  it("never gaps on a first-ever sync (since = 0)", () => {
    expect(computeGap(0, 500)).toBe(false);
  });

  it("never gaps when since is at or ahead of the floor", () => {
    expect(computeGap(500, 500)).toBe(false);
    expect(computeGap(600, 500)).toBe(false);
  });

  it("gaps when since has fallen behind the floor", () => {
    expect(computeGap(100, 500)).toBe(true);
  });
});
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
