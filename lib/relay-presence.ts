// Generated from expo-hermes; edit the private source, not this mirror.
export const LAST_SEEN_TTL_SECONDS = 30 * 24 * 60 * 60;

type PresenceRedis = {
  call: (command: string, ...args: string[]) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
};

type LastSeenRedis = {
  set: (key: string, value: string, expiry: "EX", ttlSeconds: number) => Promise<unknown>;
};

export async function readRelayPresence(
  client: PresenceRedis,
  profileId: string,
  checkedAt = new Date()
): Promise<{ online: boolean; last_seen_at: string | null; checked_at: string }> {
  const channel = `hermes:${profileId}:in`;
  const key = `hermes:${profileId}:last_seen`;
  const [subscriberResult, lastSeen] = await Promise.all([
    client.call("PUBSUB", "NUMSUB", channel),
    client.get(key),
  ]);
  const subscriberCount = Array.isArray(subscriberResult) ? subscriberResult[1] : 0;
  return {
    online: Number(subscriberCount) > 0,
    last_seen_at: lastSeen,
    checked_at: checkedAt.toISOString(),
  };
}

export function roundedLastSeen(now: Date): string {
  const rounded = new Date(now);
  rounded.setUTCSeconds(0, 0);
  return rounded.toISOString();
}

export async function writeLastSeen(
  client: LastSeenRedis,
  profileId: string,
  now = new Date()
): Promise<string> {
  const value = roundedLastSeen(now);
  await client.set(`hermes:${profileId}:last_seen`, value, "EX", LAST_SEEN_TTL_SECONDS);
  return value;
}

export function createHeartbeatMonitor(socket: { ping: () => void; terminate: () => void }) {
  let alive = true;
  let missedPongs = 0;
  return {
    pong() {
      alive = true;
    },
    tick() {
      if (!alive) missedPongs += 1;
      else missedPongs = 0;
      if (missedPongs >= 2) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        // Closing sockets are cleaned up by their close handler.
      }
    },
  };
}

export function createLastSeenTracker(
  client: LastSeenRedis,
  profileId: string,
  now: () => Date = () => new Date()
) {
  let lastSeenWriteAt = Number.NEGATIVE_INFINITY;
  const write = async () => {
    const timestamp = now();
    lastSeenWriteAt = timestamp.getTime();
    try {
      await writeLastSeen(client, profileId, timestamp);
    } catch {
      console.warn(`[ws] last_seen write failed: ${profileId}`);
    }
  };
  return {
    connect: write,
    close: write,
    async pong() {
      if (now().getTime() - lastSeenWriteAt < 60_000) return;
      await write();
    },
  };
}
