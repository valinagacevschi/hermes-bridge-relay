// Generated from expo-hermes; edit the private source, not this mirror.
/**
 * Which paired device gets notified of a chat push.
 *
 * `profiles.expo_push_tokens` can hold several phones (one profile, several
 * paired devices), but a single reply should buzz exactly one of them — not
 * every paired phone. `register+api.ts` / `pair/claim+api.ts` only
 * array_append (guarded against duplicates), never reorder, so the last
 * entry is the most recently (re-)paired device.
 *
 * Pure so server/push.ts (which opens real Redis/PG connections at module
 * load) doesn't have to be imported under test — same split as
 * lib/push-receipts.ts.
 */
export function pickNotifyToken(tokens: string[]): string | undefined {
  return tokens[tokens.length - 1];
}
