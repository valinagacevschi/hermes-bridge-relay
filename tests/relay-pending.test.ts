// Generated from expo-hermes; edit the private source, not this mirror.
import { GET } from "@/app/api/relay/pending/[profile_id]+api";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ requireApiKey: vi.fn(async () => null) }));
const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ default: { query } }));

describe("pending relay cursor", () => {
  it.each([
    { since: 10, floor: 100, rows: [], cursor: 100, gap: true },
    { since: 100, floor: 100, rows: [], cursor: 100, gap: false },
    { since: 200, floor: 100, rows: [], cursor: 200, gap: false },
    {
      since: 10,
      floor: 100,
      rows: [{ seq: "101", msg_id: "m", sealed_frame: "test" }],
      cursor: 101,
      gap: true,
    },
  ])(
    "returns cursor $cursor for since=$since floor=$floor",
    async ({ since, floor, rows, cursor, gap }) => {
      query.mockImplementation(async (sql: string) => ({
        rows: sql.includes("messages_floor_seq") ? [{ messages_floor_seq: String(floor) }] : rows,
      }));
      const response = await GET(
        new Request(`https://relay.test/api/relay/pending/p1?since=${since}`)
      );
      expect(await response.json()).toMatchObject({ cursor, gap });
    }
  );
});
