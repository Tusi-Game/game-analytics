# Redis memory budget & scale levers (ops-envelope §2–§6)

> Doc tasks T-00.66 (budget) · T-00.68 (Postgres-down posture) · T-00.70 (scale
> levers) · T-00.71 (HLL scope rule). The enforced numbers live in
> `docker-compose.yml` (`redis --maxmemory 3800mb`) and the app env
> (`REDIS_MAXMEMORY_BYTES`, `MEMORY_WATERMARK_FRACTION`, `QUEUE_DEPTH_WATERMARK`).

## 1. Budget at the 10 M events/day line (ops-envelope §3)

Redis runs `maxmemory-policy noeviction` + AOF `everysec` — nothing is ever
silently evicted, so the door must brake before OOM.

| Component | Budget |
|---|---|
| Dedup markers (24 h SET-with-TTL) — dominate steady state | 0.75 GB |
| Open-day counter buckets (≤ 3 open days × ~10 domains/game) | 0.10 GB |
| Membership sets (`act` + `payer` open days) | 0.02 GB |
| Companion staging (48 h TTL, 05) | < 0.01 GB |
| BullMQ steady state + AOF-rewrite buffers + fragmentation | 0.60 GB |
| Queue backlog headroom (~250 k batch jobs ≈ 6 M enveloped events) | ~2.5 GB |
| **Instance total** | **4 GB** (`maxmemory` ≈ 3.8 GB; door watermark 80 % ≈ 3 GB) |

Steady-state occupancy is ~1 GB (dedup markers dominate). The ~2.5 GB headroom
is the outage tolerance: ~14 h at budget mean / ~3 h at design peak before the
door 503s.

## 2. Backpressure posture (ops-envelope §4) — implemented

- **Watermark 80 % of `maxmemory` OR queue depth ~200 k jobs → 503 + Retry-After
  BEFORE ack** (`IngestShedder` → `MemoryWatermarkService`). Never shed after
  ack: the 200 receipt is a promise the batch is in the queue.
- **Redis fully down → 503 everything** (the door cannot enqueue; the watermark
  check fails closed). No data loss — nothing was acked; the SDK retains + retries.
- **Postgres down → latency, not loss (T-00.68):** durable-immediate writes fail →
  BullMQ retries with backoff (money exactly-once via the durable gate; non-money
  is a bounded, already-accepted undercount). The flush stalls harmlessly and
  catches up idempotently on recovery; day-seal defers on a failed final flush
  rather than finalizing short. The raw file still holds every event.

## 3. Per-game rate cap (ops-envelope §5) — implemented

`ingest_events_per_sec_cap` (default 200 ev/s, burst 5 000 events) — a per-game
token bucket at the door (`RateLimitService`, atomic Lua admit-or-refuse).
Whole-batch **429 + Retry-After** on breach + a `rate_limited` tally on the
ARRIVAL day; refused batches are never raw-appended (flow control, not a verdict).
O(1), no Postgres touch. A per-game `GAME.config.ingest_events_per_sec_cap`
override wins; `0` = unlimited.

## 4. Scale levers — documented, NOT built (v1 ships exact-by-default) (T-00.70)

At the §2 envelope none of these are flipped. All forward-only; none touches
money or retention truth.

| Lever | Trigger | Cost of flipping |
|---|---|---|
| **HLL for membership counts** (`act`/`payer` sets → `PFADD`) | platform DAU ≳ 650 k, or a single game DAU ≳ 200 k | same-day distincts become ±~0.8 % estimates |
| **HLL-drops-sealed-membership** (sealed sets keep counts only) | ≳ 500 k DAU or privacy preference | loses historical exact window-unions; **shrinks the erasure surface** |
| **RedisBloom for dedup** (24 h SET → Bloom, 25–40× smaller) | ≳ 25–30 M events/day | ~1-in-10³–10² non-money events falsely deduped. **NEVER money** — a false positive silently drops a real purchase; purchases keep the durable gate regardless |
| **Bucketed histogram for economy percentiles** | > ~1 M `BALANCE_SNAPSHOT` rows/game×currency, or seal-scan > flush interval | percentiles become bucket-resolution approximations |

## 5. HLL scope rule (T-00.71, Foundation §9.2 ST10) — NORMATIVE

HLL is **COUNT-ONLY**. Permitted: DAU/WAU/MAU counts. **FORBIDDEN** for any
membership-bearing read — retention offset math, new-vs-returning, "is this user
in the set". Membership-dependent reads stay exact or fall back to the spine
bitmap. Encode this rule wherever an HLL lever is later flipped: a sketch answers
"how many", never "which" or "is X a member".
