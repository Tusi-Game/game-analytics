/**
 * Redis key + hash-field builders for the `eco` / `bal` domains ([004-economy]
 * design Redis tables, T-03.6..11). All keys route through the shared grammar
 * helpers ({@link dayScopedKey}/{@link dayLessKey}) so they are byte-identical
 * across writer, flusher and read model, and the domain-palette collision guard
 * (Foundation §2.1) fires on any typo.
 *
 * Grammar (Foundation §2.1):
 *   {game_id}:eco:{logical_day}       hash — base flow cells (class M)
 *   {game_id}:eco:{logical_day}:seg   hash — segmented flow cells (class M)
 *   {game_id}:bal:{currency}          hash — user_id → balance tuple (class L)
 *   {game_id}:bal:dirty               set  — user_id\x1fcurrency entries to flush
 *   {game_id}:eco:cur                 set  — observed currency ids (registry)
 *
 * ============================ FIELD ENCODING (T-03.11) =====================
 * `currency` and `reason` are free-form and legitimately contain `:`
 * (`shop_purchase:sword`), so hash FIELD tuples are NOT `:`-joined — they use the
 * ASCII UNIT SEPARATOR (0x1F, {@link SEP}) as the delimiter. 0x1F never appears in
 * a normal currency/reason string, so encode → decode round-trips unambiguously
 * and stays stable across a Redis rehydrate. (Key SEGMENTS still use `:` per the
 * grammar — currency in the `bal:{currency}` KEY is validated `:`-free at the
 * write site by the cap gate, which only ever produces `:`-free tokens.)
 */

import { dayScopedKey, dayLessKey } from '../common/redis-keys/redis-keys';

/** ASCII unit separator — the tuple field delimiter (never in a currency/reason). */
export const SEP = '\x1f';

/** The literal `other` overflow currency bucket (kept + counted; distinct from `unknown`). */
export const OTHER_CURRENCY = 'other';

/** Provenance values that ride the flow-cell key (derived from credential class). */
export type Provenance = 'client' | 'server';
/** Flow direction — carried by this field, never by amount sign. */
export type FlowType = 'source' | 'sink';

export const EcoKeys = {
  /** `{game_id}:eco:{logical_day}` — base flow-cell hash (class M). */
  eco: (gameId: string, logicalDay: string): string => dayScopedKey(gameId, 'eco', logicalDay),
  /** `{game_id}:eco:{logical_day}:seg` — segmented flow-cell hash (class M). */
  ecoSeg: (gameId: string, logicalDay: string): string => dayScopedKey(gameId, 'eco', logicalDay, 'seg'),
  /** `{game_id}:eco:cur` — observed-currency registry set (day-less). */
  ecoCur: (gameId: string): string => dayLessKey(gameId, 'eco', 'cur'),
  /** `{game_id}:bal:{currency}` — per-user last-known-balance hash (class L). */
  bal: (gameId: string, currency: string): string => dayScopedKeyless(gameId, currency),
  /** `{game_id}:bal:dirty` — per-entry LWW dirty set (004's OWN registry, day-less). */
  balDirty: (gameId: string): string => dayLessKey(gameId, 'bal', 'dirty'),
} as const;

/**
 * `{game_id}:bal:{currency}` — the currency is a day-less qualifier here, NOT a
 * day. It is always `:`-free (the cap gate produces `:`-free tokens and `other`),
 * so it is grammar-safe as a qualifier segment.
 */
function dayScopedKeyless(gameId: string, currency: string): string {
  return dayLessKey(gameId, 'bal', currency);
}

// ---------------------------------------------------------------------------
// Measure tag: each flow cell carries TWO measures (amount_sum + event_count,
// BLOCKER-B) in the SAME hash, distinguished by a leading measure tag so both are
// per-field HINCRBY-able + HSETNX-seedable and the projector pairs them per cell.
// ---------------------------------------------------------------------------

/** Leading tuple element selecting which measure a field holds. */
export type EcoMeasure = 'a' | 'n'; // 'a' = amount_sum, 'n' = event_count
export const MEASURE_AMOUNT: EcoMeasure = 'a';
export const MEASURE_COUNT: EcoMeasure = 'n';

// ---------------------------------------------------------------------------
// Base flow-cell field tuple: (measure, provenance, flow_type, currency, reason).
// ---------------------------------------------------------------------------

/** Build a base `eco` hash field: `measure␟provenance␟flow_type␟currency␟reason`. */
export function ecoField(
  measure: EcoMeasure,
  provenance: Provenance,
  flowType: FlowType,
  currency: string,
  reason: string,
): string {
  return [measure, provenance, flowType, currency, reason].join(SEP);
}

/** Parsed parts of a base `eco` hash field (the measure + the cell tuple). */
export interface EcoCell {
  measure: string;
  provenance: string;
  flowType: string;
  currency: string;
  reason: string;
}

/**
 * Parse a base `eco` hash field back into (measure + cell tuple), or null if
 * malformed. 0x1F only ever separates, so the split is on exactly the 4 leading
 * separators; anything after the 4th is `reason` verbatim (a reason embedding no
 * separator stays intact; a stray 0x1F is impossible in a real reason string).
 */
export function parseEcoField(field: string): EcoCell | null {
  const parts = field.split(SEP);
  if (parts.length < 5) {
    return null;
  }
  const [measure, provenance, flowType, currency, ...reasonParts] = parts;
  if (measure === undefined || provenance === undefined || flowType === undefined || currency === undefined) {
    return null;
  }
  return { measure, provenance, flowType, currency, reason: reasonParts.join(SEP) };
}

// ---------------------------------------------------------------------------
// Segmented flow-cell field tuple:
// (measure, provenance, flow_type, currency, segment_dim, segment_value, reason).
// ---------------------------------------------------------------------------

/** Segment axis — independent axes only (never the level×region cross-product). */
export type SegmentDim = 'level_bucket' | 'region';

/** Build a segmented `eco:seg` hash field. */
export function ecoSegField(
  measure: EcoMeasure,
  provenance: Provenance,
  flowType: FlowType,
  currency: string,
  segmentDim: SegmentDim,
  segmentValue: string,
  reason: string,
): string {
  return [measure, provenance, flowType, currency, segmentDim, segmentValue, reason].join(SEP);
}

/** Parsed parts of a segmented `eco:seg` hash field. */
export interface EcoSegCell extends EcoCell {
  segmentDim: string;
  segmentValue: string;
}

/** Parse a segmented `eco:seg` hash field, or null if malformed. */
export function parseEcoSegField(field: string): EcoSegCell | null {
  const parts = field.split(SEP);
  if (parts.length < 7) {
    return null;
  }
  const [measure, provenance, flowType, currency, segmentDim, segmentValue, ...reasonParts] = parts;
  if (
    measure === undefined ||
    provenance === undefined ||
    flowType === undefined ||
    currency === undefined ||
    segmentDim === undefined ||
    segmentValue === undefined
  ) {
    return null;
  }
  return { measure, provenance, flowType, currency, segmentDim, segmentValue, reason: reasonParts.join(SEP) };
}

// ---------------------------------------------------------------------------
// bal hash-value tuple:
// (last_known_balance, as_of_ms, provenance, server_received_ms, event_id).
// The last two are the deterministic tie-break keys for an EQUAL as_of (T-03.24:
// later server_received wins, then greatest event_id). They live in the hot tuple
// so the guard is arrival-order-independent; the durable row only needs as_of +
// balance + provenance (the flush guard is `as_of >=`), so a durable point-read
// seed defaults the tie-break keys to neutral (server_received = as_of, id = '').
// ---------------------------------------------------------------------------

/** The value stored per user_id field in a `bal:{currency}` hash. */
export interface BalanceEntry {
  /** Last-known balance (bigint magnitude, string form). */
  balance: string;
  /** Corrected event-time (epoch ms) of the last writer — the LWW `as_of`. */
  asOfMs: number;
  /** Provenance of the last writer (advisory). */
  provenance: string;
  /** Tie-break 1 (equal as_of): later server-received-time wins. */
  serverReceivedMs: number;
  /** Tie-break 2 (equal as_of + server-received): greatest event_id wins. */
  eventId: string;
}

/** Encode a balance entry into its hash-value string. */
export function encodeBalanceEntry(entry: BalanceEntry): string {
  return [entry.balance, String(entry.asOfMs), entry.provenance, String(entry.serverReceivedMs), entry.eventId].join(
    SEP,
  );
}

/** Decode a `bal` hash-value string back into a balance entry, or null if malformed. */
export function decodeBalanceEntry(value: string): BalanceEntry | null {
  const parts = value.split(SEP);
  if (parts.length !== 5) {
    return null;
  }
  const [balance, asOfRaw, provenance, srvRaw, eventId] = parts;
  if (
    balance === undefined ||
    asOfRaw === undefined ||
    provenance === undefined ||
    srvRaw === undefined ||
    eventId === undefined
  ) {
    return null;
  }
  const asOfMs = Number(asOfRaw);
  const serverReceivedMs = Number(srvRaw);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(serverReceivedMs)) {
    return null;
  }
  return { balance, asOfMs, provenance, serverReceivedMs, eventId };
}

/**
 * Compare two candidate balance writers under the LWW rule + tie-break
 * (T-03.22/24). Returns true iff `incoming` should WIN over `stored`:
 *   1. later `as_of` wins;
 *   2. equal `as_of` → later `server_received` wins;
 *   3. equal both → greatest `event_id` wins;
 *   4. fully equal → a no-op (incoming does NOT win — a retry never re-clobbers).
 * Deterministic and arrival-order-independent.
 */
export function incomingWins(incoming: BalanceEntry, stored: BalanceEntry): boolean {
  if (incoming.asOfMs !== stored.asOfMs) {
    return incoming.asOfMs > stored.asOfMs;
  }
  if (incoming.serverReceivedMs !== stored.serverReceivedMs) {
    return incoming.serverReceivedMs > stored.serverReceivedMs;
  }
  return incoming.eventId > stored.eventId;
}

/** The `bal:dirty` set member for a (user_id, currency) pair. */
export function balDirtyMember(userId: string, currency: string): string {
  return [userId, currency].join(SEP);
}

/** Parse a `bal:dirty` set member back into (user_id, currency), or null. */
export function parseBalDirtyMember(member: string): { userId: string; currency: string } | null {
  const parts = member.split(SEP);
  if (parts.length !== 2) {
    return null;
  }
  const [userId, currency] = parts;
  if (userId === undefined || currency === undefined) {
    return null;
  }
  return { userId, currency };
}

/** Parse the day out of a `{game_id}:eco:{day}` or `{game_id}:eco:{day}:seg` key. */
export function parseEcoBucketKey(bucketKey: string): { gameId: string; day: string; seg: boolean } | null {
  const parts = bucketKey.split(':');
  // {game}:eco:{day}  → 3 parts ; {game}:eco:{day}:seg → 4 parts
  if (parts.length === 3 && parts[1] === 'eco') {
    return { gameId: parts[0]!, day: parts[2]!, seg: false };
  }
  if (parts.length === 4 && parts[1] === 'eco' && parts[3] === 'seg') {
    return { gameId: parts[0]!, day: parts[2]!, seg: true };
  }
  return null;
}
