/**
 * Redis key grammar (foundation §2.1).
 *
 * One grammar, two patterns:
 *   {game_id}:{domain}:{utc_day}[:{qualifier…}]   — day-scoped (open-day buckets)
 *   {game_id}:{domain}[:{qualifier…}]             — day-less (dedup, registries)
 *
 * Domain tags are OWNED (one story writes a domain; others may read). This
 * module holds the full palette registry so a typo or a colliding new tag is a
 * compile/throw, not a silent cross-story key clash (R8).
 */

/**
 * Domains 002 (foundation-ingest) itself writes.
 */
export const OWNED_DOMAINS_002 = ['cnt', 'cat', 'dedup'] as const;

/**
 * The full reserved domain palette across every story (foundation §2.1). 002
 * does not write these, but they are reserved so no future tag collides and so
 * the grammar helper can validate any story's key.
 *   sess+act (02) · eco+bal (03) · ret (04) · mon+payer+rev+stage (05)
 */
export const RESERVED_STORY_DOMAINS = ['sess', 'act', 'eco', 'bal', 'ret', 'mon', 'payer', 'rev', 'stage'] as const;

/**
 * Operational / panel namespaces (TTL-bounded, R8). Kept distinct so ops and
 * panel keys never collide with a result domain.
 */
export const OPS_DOMAINS = ['ops', 'panel'] as const;

/** Every allowed domain tag. */
export const ALL_DOMAINS = [...OWNED_DOMAINS_002, ...RESERVED_STORY_DOMAINS, ...OPS_DOMAINS] as const;

export type Domain = (typeof ALL_DOMAINS)[number];

const DOMAIN_SET: ReadonlySet<string> = new Set(ALL_DOMAINS);

/** True iff `tag` is a registered domain in the palette. */
export function isDomain(tag: unknown): tag is Domain {
  return typeof tag === 'string' && DOMAIN_SET.has(tag);
}

/** A key segment may not contain the `:` separator (it would break the grammar). */
function assertSegment(kind: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`[redis-keys] ${kind} segment must be non-empty`);
  }
  if (value.includes(':')) {
    throw new Error(`[redis-keys] ${kind} segment "${value}" must not contain ':'`);
  }
}

function assertDomain(domain: string): asserts domain is Domain {
  if (!isDomain(domain)) {
    throw new Error(
      `[redis-keys] unknown domain "${domain}". Register it in ALL_DOMAINS before use (collision guard, foundation §2.1).`,
    );
  }
}

/**
 * Build a DAY-SCOPED key: `{game_id}:{domain}:{utc_day}[:{qual…}]`.
 * `utcDay` is the corrected logical day "YYYY-MM-DD". Extra qualifiers append in
 * order (e.g. `['exc']` → `…:{day}:exc`, `['rank']` → `…:{day}:rank`).
 */
export function dayScopedKey(gameId: string, domain: string, utcDay: string, ...qualifiers: string[]): string {
  assertSegment('game_id', gameId);
  assertDomain(domain);
  assertSegment('utc_day', utcDay);
  qualifiers.forEach((q) => assertSegment('qualifier', q));
  return [gameId, domain, utcDay, ...qualifiers].join(':');
}

/**
 * Build a DAY-LESS key: `{game_id}:{domain}[:{qual…}]`.
 * Used for dedup markers, registries and staging (e.g. `dedup:{event_id}`,
 * `cat:{event_name}`, `cat:names`).
 */
export function dayLessKey(gameId: string, domain: string, ...qualifiers: string[]): string {
  assertSegment('game_id', gameId);
  assertDomain(domain);
  qualifiers.forEach((q) => assertSegment('qualifier', q));
  return [gameId, domain, ...qualifiers].join(':');
}

/**
 * Named 002-owned key builders — the canonical spellings the ingest story uses.
 * Centralised so every consumer produces byte-identical keys.
 */
export const IngestKeys = {
  /** `{game_id}:dedup:{event_id}` — windowed dedup marker (24 h fixed). */
  dedup: (gameId: string, eventId: string): string => dayLessKey(gameId, 'dedup', eventId),
  /** `{game_id}:cnt:{utc_day}` — per-name day-count hash (field = event_name). */
  cnt: (gameId: string, utcDay: string): string => dayScopedKey(gameId, 'cnt', utcDay),
  /** `{game_id}:cnt:{utc_day}:exc` — per-reason day-tally hash (field = reason). */
  cntExc: (gameId: string, utcDay: string): string => dayScopedKey(gameId, 'cnt', utcDay, 'exc'),
  /** `{game_id}:cnt:{utc_day}:rank` — display-only top-N zset (never flushed). */
  cntRank: (gameId: string, utcDay: string): string => dayScopedKey(gameId, 'cnt', utcDay, 'rank'),
  /** `{game_id}:cat:{event_name}` — day-less per-name catalog hash. */
  cat: (gameId: string, eventName: string): string => dayLessKey(gameId, 'cat', eventName),
  /** `{game_id}:cat:names` — registered-name set (name-cap gate). */
  catNames: (gameId: string): string => dayLessKey(gameId, 'cat', 'names'),
} as const;

/**
 * Operational key builders under the reserved `ops:*` namespace (R8). Everything
 * here is TTL-bounded — safe under `noeviction` — and platform-scoped (not a
 * per-game result domain). The per-game rate-limit token bucket lives here.
 */
export const OpsKeys = {
  /**
   * `{game_id}:ops:ratelimit` — the per-game token-bucket state hash (fields
   * `tokens` + `ts`) for `ingest_events_per_sec_cap` (ops-envelope §5). TTL-bounded.
   */
  rateLimit: (gameId: string): string => dayLessKey(gameId, 'ops', 'ratelimit'),

  /**
   * `ops:opsession:{session_id}` — 011 operator session store (R8, TTL-bounded).
   * NOT game-scoped (operators are cross-game staff), so the game_id segment is a
   * fixed `_ops` placeholder — the grammar still validates and keys never collide
   * with a per-game result domain. Value is the JSON session record.
   */
  operatorSession: (sessionId: string): string => dayLessKey('_ops', 'ops', 'opsession', sessionId),

  /**
   * `{game_id}:ops:creduse` — R7 last-use coalesce hash for a game's credentials.
   * Field = `{kind}:{id}` (kind ∈ sdk|srv), value = last-seen epoch ms (LWW).
   * The resolver stamps this O(1) on the hot path (NO Postgres write); the flush
   * sweep drains it into the child-table `last_used_at`. TTL-bounded (R8).
   */
  credUse: (gameId: string): string => dayLessKey(gameId, 'ops', 'creduse'),

  /**
   * `{game_id}:ops:cfgcache` — 011 worker config-cache snapshot (T-10.26).
   * Reserved here so the tag is registered; the cache itself is Unit B.
   */
  workerConfigCache: (gameId: string): string => dayLessKey(gameId, 'ops', 'cfgcache'),
} as const;

/** Field builder for the {@link OpsKeys.credUse} hash: `{kind}:{id}`. */
export function credUseField(kind: 'sdk' | 'srv', id: string): string {
  return `${kind}:${id}`;
}

/** TTL (seconds) for the last-use coalesce hash — one flush cadence + margin. */
export const CRED_USE_TTL_SECONDS = 15 * 60;

/**
 * Panel (012) operational key builders under the reserved `panel:*` namespace
 * (R8). Everything here is TTL-bounded — safe under Redis `noeviction` — and
 * platform-scoped (NOT a per-game result domain). The panel is a pure READER of
 * result domains; the only Redis writes it makes are these short-lived
 * presentation-state flags. `_panel` is a fixed non-game placeholder segment so
 * the day-less grammar validates and these keys can never collide with a per-game
 * result domain.
 */
export const PanelKeys = {
  /**
   * `_panel:panel:credshow:{credential_id}:{operator_id}` — the credential
   * show-once flag (spec §2.2 `credential-show.njk`, T-11.37). Set with a 5-min
   * TTL when a credential's raw value is minted; the show page renders the raw
   * value exactly once behind this flag, then consumes it. The RAW value is NEVER
   * stored here — only the presence flag gates the (server-held, per-request)
   * value. TTL-bounded (R8/P13).
   */
  credentialShow: (credentialId: string, operatorId: string): string =>
    dayLessKey('_panel', 'panel', 'credshow', credentialId, operatorId),
} as const;

/** TTL (seconds) for the credential show-once flag — 5 minutes (spec §2.2). */
export const PANEL_CREDENTIAL_SHOW_TTL_SECONDS = 5 * 60;
