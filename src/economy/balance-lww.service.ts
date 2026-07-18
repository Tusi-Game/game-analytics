/**
 * Class-L balance LWW hot guard ([004-economy] design "LWW by corrected time",
 * T-03.22/23/24). The depth trap: a STALE `as_of` must NEVER clobber a NEWER one.
 * Guarded at THREE layers (this is guards 1 + tie-break; the flush guard is the
 * class-L merge in economy-flush-plans.ts):
 *
 *   1. HOT GUARD (here) — overwrite the `{game}:bal:{currency}` entry only if the
 *      incoming writer wins under {@link incomingWins} (later as_of; equal → later
 *      server_received; equal → greatest event_id).
 *   2. PER-ENTRY REHYDRATE-ON-MISS (here) — on a hash-entry miss, seed from the
 *      durable BALANCE_SNAPSHOT point-read BEFORE comparing, so a stale
 *      offline-buffered event arriving after a Redis crash cannot clobber a newer
 *      DURABLE balance. No durable row ⇒ accept the incoming write.
 *   3. FLUSH GUARD (economy-flush-plans.ts) — the class-L merge upserts only where
 *      `EXCLUDED.as_of >= balance_snapshot.as_of`; a retried/duplicated flush
 *      writes identical absolutes ⇒ no-op by construction.
 *
 * GREATEST-on-balance is FORBIDDEN — a balance legitimately FALLS. The whole
 * mechanism is `as_of` LWW, never max.
 *
 * The compare-and-set is ONE atomic Lua EVAL over the single hash entry so two
 * workers racing on the same (user, currency) cannot interleave a read-modify-write
 * and lose the newer value.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { SEEDED_MARKER_FIELD } from '../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../workers/flush/dirty-registry';
import { EconomyFloorProvider } from './economy-floor.provider';
import {
  EcoKeys,
  balDirtyMember,
  decodeBalanceEntry,
  encodeBalanceEntry,
  incomingWins,
  type BalanceEntry,
} from './eco-keys';

/**
 * Atomic guarded upsert of one `bal:{currency}` hash entry + `bal:dirty` mark.
 *   KEYS[1] = bal:{currency} hash
 *   KEYS[2] = bal:dirty set
 *   ARGV[1] = user_id (hash field)
 *   ARGV[2] = incoming encoded entry
 *   ARGV[3] = incoming as_of_ms
 *   ARGV[4] = incoming server_received_ms
 *   ARGV[5] = incoming event_id
 *   ARGV[6] = optional durable-seed encoded entry (empty string = no durable row)
 *   ARGV[7] = bal:dirty member (user_id␟currency)
 * Returns 1 if the incoming won (written), 0 if rejected (stale/tie-noop).
 *
 * Field format is `balance␟asOfMs␟provenance␟serverReceivedMs␟eventId` (0x1F
 * separated). The Lua compares numerically on as_of then server_received, then
 * lexically on event_id — byte-identical to {@link incomingWins}.
 */
const GUARDED_UPSERT_LUA = `
local SEP = string.char(31)
local function split5(s)
  local out = {}
  local idx = 1
  for part in (s .. SEP):gmatch('(.-)' .. SEP) do
    out[idx] = part
    idx = idx + 1
  end
  return out
end
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing == false and ARGV[6] ~= '' then
  -- Per-entry rehydrate-on-miss: seed the durable point-read, then compare.
  existing = ARGV[6]
end
local win = true
if existing ~= false then
  local e = split5(existing)
  local eAsOf = tonumber(e[2]) or -1
  local eSrv = tonumber(e[4]) or -1
  local eId = e[5] or ''
  local iAsOf = tonumber(ARGV[3])
  local iSrv = tonumber(ARGV[4])
  local iId = ARGV[5]
  if iAsOf ~= eAsOf then
    win = iAsOf > eAsOf
  elseif iSrv ~= eSrv then
    win = iSrv > eSrv
  else
    win = iId > eId
  end
end
if win then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  -- Mark the bal:{currency} hash SEEDED so the shared flusher does not skip it
  -- (it is per-entry point-read rehydrated, never whole-bucket seeded; the marker
  -- is stripped by the projector). ARGV[8] is the seeded-marker field name.
  redis.call('HSET', KEYS[1], ARGV[8], '1')
  redis.call('SADD', KEYS[2], ARGV[7])
  return 1
end
return 0
`;

@Injectable()
export class BalanceLwwService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly floors: EconomyFloorProvider,
    private readonly dirty: DirtyRegistry,
  ) {}

  /**
   * Guarded LWW upsert of a user's balance for a currency. Rehydrates the entry
   * from the durable snapshot on a hash miss (so a post-crash stale event never
   * regresses the durable balance), then applies the incoming write only if it
   * wins. Marks `bal:dirty` on a win. Returns true iff the write was applied.
   */
  async upsert(gameId: string, userId: string, currency: string, incoming: BalanceEntry): Promise<boolean> {
    const balKey = EcoKeys.bal(gameId, currency);
    const dirtyKey = EcoKeys.balDirty(gameId);

    // Per-entry rehydrate seed: only fetch the durable point-read when the hash
    // entry is missing (avoid a Postgres read on the hot happy-path).
    let seed = '';
    const present = await this.redis.hexists(balKey, userId);
    if (!present) {
      const durable = await this.floors.balPointRead(gameId, userId, currency);
      if (durable) {
        seed = encodeBalanceEntry(durable);
      }
    }

    const applied = await this.redis.eval(
      GUARDED_UPSERT_LUA,
      2,
      balKey,
      dirtyKey,
      userId,
      encodeBalanceEntry(incoming),
      String(incoming.asOfMs),
      String(incoming.serverReceivedMs),
      incoming.eventId,
      seed,
      balDirtyMember(userId, currency),
      SEEDED_MARKER_FIELD,
    );
    // Mark the `bal:{currency}` bucket dirty in the SHARED registry so the standard
    // sweep flushes it under the class-L plan. (bal:dirty — 004's OWN per-entry
    // set, written inside the Lua — is used by the seal-time supply snapshot + the
    // loss-posture accounting, distinct from ops:dirty.)
    if (applied === 1) {
      await this.dirty.mark('bal', balKey);
    }
    return applied === 1;
  }

  /** Read a live `bal` entry (for tests / read-time), decoded, or null. */
  async read(gameId: string, userId: string, currency: string): Promise<BalanceEntry | null> {
    const raw = await this.redis.hget(EcoKeys.bal(gameId, currency), userId);
    return raw === null ? null : decodeBalanceEntry(raw);
  }
}

/** Re-export for callers that only want the pure decision (unit-testable). */
export { incomingWins };
