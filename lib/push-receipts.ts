// Generated from expo-hermes; edit the private source, not this mirror.
/**
 * Expo push receipt reconciliation (#65).
 *
 * Sending a push is two-phase. `POST /--/api/v2/push/send` returns a *ticket*,
 * which only means Expo accepted the message. The real outcome — including a
 * token APNs/FCM has revoked — appears later on
 * `POST /--/api/v2/push/getReceipts`. `server/push.ts` checked only the ticket,
 * so a token that died after acceptance kept producing `[push] sent` forever,
 * was never pruned, and nothing anywhere showed that delivery had stopped.
 *
 * Also treats APNs BadDeviceToken (surfaces as Expo DeveloperError) as dead:
 * single-device notify picks the last token, so an unpruned BadDeviceToken
 * permanently silences pushes while older healthy tokens sit unused.
 *
 * This module holds the pure decision logic; server/push.ts owns the timer,
 * the HTTP call and the DB writes — same split as lib/relay-events.ts and its
 * route.
 */

/** Expo's per-receipt shape. `details.error` carries the machine-readable code. */
export type ExpoReceipt = {
  status?: string;
  message?: string;
  details?: {
    error?: string;
    /** Present on some iOS receipt errors (e.g. BadDeviceToken). */
    apns?: { reason?: string; statusCode?: number };
  };
};

export type PendingTicket = {
  profileId: string;
  token: string;
  /** epoch ms when the ticket was issued. */
  sentAt: number;
};

/** Expo accepts up to 1000 ids per getReceipts call. Stay well under it. */
export const RECEIPT_BATCH_MAX = 300;

/**
 * How long to keep asking before giving up on a ticket. Expo's receipts are
 * not instant and are retained ~24h; a receipt that never materialises within
 * this window is not worth unbounded memory in a long-lived process.
 */
export const RECEIPT_MAX_AGE_MS = 30 * 60 * 1000;

/** Wait before the first lookup — a receipt asked for too early is simply absent. */
export const RECEIPT_MIN_AGE_MS = 30 * 1000;

export const RECEIPT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Classic "device gone" code from Expo receipts/tickets. Still the primary
 * prune signal; see also isDeadTokenError for APNs BadDeviceToken.
 */
export const DEAD_TOKEN_ERROR = "DeviceNotRegistered";

/** APNs reason that means this Expo push token can never deliver again. */
export const BAD_DEVICE_TOKEN_REASON = "BadDeviceToken";

/**
 * Permanent token failures — stop sending to this token forever.
 * Transient/config faults (MessageTooBig, MessageRateExceeded,
 * InvalidCredentials, MismatchSenderId) must NOT prune: that would silently
 * unregister a healthy device.
 */
export function isDeadTokenError(
  error: string | undefined,
  details?: ExpoReceipt["details"],
  message?: string
): boolean {
  if (error === DEAD_TOKEN_ERROR) return true;
  // APNs BadDeviceToken usually arrives as details.error=DeveloperError plus
  // details.apns.reason (and often the reason echoed in message). Either
  // signal is enough — ticket-time errors may omit the apns object.
  if (details?.apns?.reason === BAD_DEVICE_TOKEN_REASON) return true;
  if (error === "DeveloperError" && message?.includes(BAD_DEVICE_TOKEN_REASON)) return true;
  return false;
}

/** Receipt-shaped wrapper around isDeadTokenError. */
export function isDeadTokenReceipt(receipt: ExpoReceipt): boolean {
  return isDeadTokenError(receipt.details?.error, receipt.details, receipt.message);
}

export type SweepPlan = {
  /** Ticket ids old enough to look up now, capped at RECEIPT_BATCH_MAX. */
  query: string[];
  /** Ticket ids past RECEIPT_MAX_AGE_MS — drop them, no verdict is coming. */
  abandon: string[];
};

/** Decide which pending tickets to ask about, and which to give up on. */
export function planReceiptSweep(
  pending: ReadonlyMap<string, PendingTicket>,
  now: number
): SweepPlan {
  const query: string[] = [];
  const abandon: string[] = [];
  for (const [ticketId, t] of pending) {
    const age = now - t.sentAt;
    if (age > RECEIPT_MAX_AGE_MS) abandon.push(ticketId);
    else if (age >= RECEIPT_MIN_AGE_MS && query.length < RECEIPT_BATCH_MAX) query.push(ticketId);
  }
  return { query, abandon };
}

export type ReceiptVerdicts = {
  /** Confirmed delivered — drop from pending. */
  delivered: string[];
  /** Token is permanently gone: prune it. */
  dead: Array<{ ticketId: string; profileId: string; token: string; error: string }>;
  /** Failed for some other reason — log it, drop it, keep the token. */
  failed: Array<{ ticketId: string; profileId: string; error: string; message?: string }>;
  /** No verdict yet — leave in pending and ask again next sweep. */
  unresolved: string[];
};

/**
 * Turn a getReceipts response into actions. A ticket id absent from the
 * response has no verdict yet and must NOT be treated as delivered — that
 * would reintroduce exactly the blind spot this module exists to close.
 */
export function interpretReceipts(
  receipts: Record<string, ExpoReceipt> | null | undefined,
  queried: readonly string[],
  pending: ReadonlyMap<string, PendingTicket>
): ReceiptVerdicts {
  const out: ReceiptVerdicts = { delivered: [], dead: [], failed: [], unresolved: [] };
  for (const ticketId of queried) {
    const receipt = receipts?.[ticketId];
    if (!receipt || typeof receipt.status !== "string") {
      out.unresolved.push(ticketId);
      continue;
    }
    if (receipt.status === "ok") {
      out.delivered.push(ticketId);
      continue;
    }
    const t = pending.get(ticketId);
    const error = receipt.details?.error ?? "unknown";
    if (t && isDeadTokenReceipt(receipt)) {
      out.dead.push({ ticketId, profileId: t.profileId, token: t.token, error });
    } else {
      out.failed.push({
        ticketId,
        profileId: t?.profileId ?? "unknown",
        error,
        message: receipt.message,
      });
    }
  }
  return out;
}
