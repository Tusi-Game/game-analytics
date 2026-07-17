# Phase 03 — Economy (Sink / Source)

**Feature**: 001-analytics-platform · **Story**: US2 (P2 — the headline differentiator) · **Reserved kind owned**: `economy` · **Status**: Draft
**Depends on**: Phase 01 (ingest substrate). References Phase 02 for `session_id` provenance and the server-SDK trust path (shared with Phase 05).
**Deeper reference**: [`../metrics/02-economy-sink-source.md`](../metrics/02-economy-sink-source.md). **Spec**: US2, FR-012/013/014.
**Excluded here** (→ later per-phase design): key layouts, DDL, worker layout.

---

## 1. Story understanding

**The story.** The developer sends currency-flow events — currency granted = **source/faucet**, currency spent = **sink/drain** — and sees, per game per currency over time, total sources vs sinks, net flow, sink ratio, the biggest faucets and biggest drains by reason, and how deep players' balances are.

**The question it answers.** *Is this game's economy healthy, or is it inflating?* For each virtual currency: how much is being created vs destroyed, which mechanics are the biggest faucets/drains, and how much currency players are sitting on. This is the feature no surveyed self-hostable tool offers first-class — the primary reason to build.

**What it means for the operator.** A standalone economy dashboard: net flow persistently positive ⇒ inflation risk; sink ratio ≈ 1.0 ⇒ healthy balanced create/destroy; the top-faucet/top-drain lists say *which mechanic* to tune. Currencies are tracked **independently** — gold, gems, energy each inflate on their own curve; **no cross-currency total** (no FX between virtual currencies in v1).

**Chosen measure: flow, not balance-diff.** We sum per-event signed magnitudes into daily source/sink totals. Rejected: balance-diff inference (needs per-user ordered balance history — impossible under results-only, and blind to *why*) and net-only tracking (can't produce sink ratio or the breakdown). Gross source and gross sink are the irreducible measures; everything else derives from them.

**Trust boundary.** Economy events are spoofable when client-sent. Two tiers, both accepted but distinguishable: **client SDK** (convenience path for client-only flows, untrusted) and **server SDK** (the trusted path for server-granted/debited currency where integrity matters). A `client`/`server` provenance flag should be derivable so a dashboard can show trusted-only totals. The platform records provenance; it does not re-validate currency math in v1.

---

## 2. How it is calculated

**Time-bucketing.** The platform **logical day** (Foundation §4.7 — `utc_day(corrected + reporting_offset)`, single platform timezone; every "UTC day" below reads as the logical day), skew-corrected client time; 48 h then seals; late events quarantined.

**Grain.** Base = **game × currency × UTC-day × reason × flow_type** (a source-total and a sink-total at each). Headline figures are the reason-collapsed rollup. Optional secondary grain adds player-context dimensions (level bucket, region) where present.

**Formulas (per game × currency × day unless a segment is named):**
```
total_source        = Σ amount where flow_type = source
total_sink          = Σ amount where flow_type = sink
net_flow            = total_source − total_sink
sink_ratio          = total_sink / total_source          (N/A if total_source = 0)
per_reason_source[r]= Σ amount where flow_type = source AND reason = r
per_reason_sink[r]  = Σ amount where flow_type = sink   AND reason = r
top_faucets         = per_reason_source sorted desc, take economy_top_n_reasons
top_drains          = per_reason_sink   sorted desc, take economy_top_n_reasons
money_supply(cur)   = Σ over users of (last-known balance_after for cur)   (point-in-time)
depth_pXX(cur)      = percentile XX of per-user last-known balances
```

### Worked example — one game, one UTC day, two currencies

Valid events that day (abbreviated):

| flow | currency | amount | reason |
|---|---|---|---|
| source | gold | 500 | quest_reward |
| source | gold | 300 | quest_reward |
| source | gold | 200 | daily_bonus |
| source | gold | 1000 | pvp_win |
| sink | gold | 400 | shop_purchase:sword |
| sink | gold | 250 | upgrade:barracks |
| sink | gold | 150 | repair |
| source | gems | 50 | daily_bonus |
| sink | gems | 80 | shop_purchase:skin |
| sink | gems | 20 | time_skip |

**Gold:** source = 2000, sink = 800, **net = +1200**, **sink ratio = 0.40**; top faucet = **pvp_win (1000)**; top drain = **shop_purchase:sword (400)**.
**Gems:** source = 50, sink = 100, **net = −50**, **sink ratio = 2.00**; top faucet = daily_bonus (50); top drain = shop_purchase:skin (80).

**Health read.** Gold is strongly faucet-positive (only 40% of created gold is drained → inflating; pvp_win out-emits every sink → throttle it or add a gold sink). Gems the opposite (spent faster than earned → draining reserves). Sink ratio ≈ 1.0 is the healthy target; this game is out of balance in opposite directions on the two currencies — exactly what US2's dashboard exists to surface.

**Currency depth (gold):** last-known balances u1=1300, u2=800, u3=2200 → money_supply = **4300**, median depth = **1300**. Rising money supply day-over-day corroborates the positive net-flow reading.

`sink_ratio` with source = 0 renders **N/A**. Today (and the 48 h grace) is provisional.

---

## 3. Data needed (input)

Economy is a **strictly-validated typed kind** (`kind = economy`). Rides the envelope; the economy payload:

**Required** (a missing/invalid one → quarantine to raw, never silently dropped):

| Field | Meaning |
|---|---|
| `flow_type` | `source` or `sink` — nothing else valid. |
| `currency_type` | Currency id (`gold`, `gems`, …), per-game namespace, tracked independently. |
| `amount` | Positive magnitude; direction is carried by `flow_type`, **never** by sign — `amount` is always > 0. |
| `reason` / `category` | Why the flow happened; drives the faucet/drain breakdown. |

**Optional:**

| Field | Meaning |
|---|---|
| `balance_after` | Player's balance of `currency_type` after this flow; feeds depth/money-supply. Omitting it only removes that event from depth. |
| player context (`player_level`→`level_bucket`, `region`, …) | For segmented economy where present. |

Provenance: a `client`/`server` `source` flag should ride each economy event (mirrors the purchase flag) so trusted-only totals are derivable.

---

## 4. Data stored for longer-run processing

- **Primary result — per game × currency × UTC-day × reason × flow_type:** a running summed `amount`. Collapse `reason` for headline source/sink → net flow, sink ratio; keep `reason` for the faucet/drain breakdown. Everything in §2 (except depth) derives from this one grain.
- **Segmented result (optional, where context present) — same, plus segment keys** (level_bucket, region). Multiplies cardinality by the segment fan-out; kept bounded by the level-bucket config and by only materializing observed segments.
- **Currency depth (optional per-user-spine touch) — last-known balance per (game, user, currency):** an *upsert-latest* snapshot (last-writer-by-corrected-event-time wins), **not** an append log. Money supply = Σ of these; depth = distribution over them. Only when `economy_depth_capture_mode` is on.

**Per-user spine.** The core source/sink/net/ratio/breakdown metrics need **zero** per-user state — pure per-day aggregate accumulation. Depth adds *at most* the optional last-known-balance-per-user×currency, only when enabled. No per-event balance history is ever stored. All of §2 is computable without raw re-scan. ✓

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only.*

**Redis (transient, hot).**
- **Today's economy accumulators** — per game × currency × day × reason × flow: running summed amounts. Headline totals are the reason-collapsed read. Hot, lost on crash (accepted; ≤ 5 min drift + today).
- **Today's segmented accumulators** — the same, keyed with segment values, for observed segments only.
- **Last-known balance map** (if depth on) — per user × currency, upsert-latest.
- **The 24 h dedup window** — shared; economy dedups by `event_id` + 24 h.

**Database (durable, results-only).**
- **Economy flow results** — durable per game × currency × sealed-day × reason × flow summed totals; net/ratio/breakdown are reads over these.
- **Segmented economy results** — the same with segment keys, bounded.
- **Money-supply / depth snapshot** — the durable last-known-balance distribution per game × currency (if depth on).

**The bridge.** Hot accumulators flush to durable results on the cadence (idempotent absolute upsert — a retried flush is a no-op). Note the residual: absolute-upsert protects the *flush*, but a within-24 h retry is caught by `event_id` dedup; a retry landing >24 h later double-counts a flow (accepted indie-scale tradeoff for non-money events — economy is not money).

---

## 6. Configurations

| Knob | Default | Range / values | Forward / retro |
|---|---|---|---|
| `economy_top_n_reasons` | 10 | 1–100 | **Retroactive** — display-time ranking/truncation over stored per-reason totals; no re-bucketing. |
| `economy_ratio_min_events` | 100 | 1–100000 | **Display-only** — below this per-leg event count, sink_ratio is annotated low-volume/unreliable (§2 read-model). Mutates no stored cell. |
| `economy_currency_allowlist` | empty = accept all | set of currency strings | **Forward-only** — enabling rejection leaves past aggregates untouched; default accepts + auto-registers any currency (accept-all posture). |
| `economy_depth_capture_mode` | `last_known_balance` | `last_known_balance` / `off` | **Forward-only** — depth is only computable for days processed while enabled; turning it on does not backfill sealed days. |
| `level_bucket_boundaries` (shared) | platform default | ascending level thresholds | **Forward-only** — re-bucketing sealed segmented aggregates violates immutability. |
| `per_game_reporting_timezone_offset` (shared) | UTC | offset | **Display-only** — never re-buckets; economy days stay UTC internally. |

**Inherited globals:** flush 5 min, dedup 24 h, day-seal 48 h, event-name cap 500. Rule: anything touching sealed aggregates is forward-only; the two retroactive knobs above only re-read/re-rank already-stored results.

---

## Cross-references

- Deeper sheet: [`../metrics/02-economy-sink-source.md`](../metrics/02-economy-sink-source.md) — quarantine rules, spoofed-client mitigation, unknown-currency proliferation, depth-capture and provenance-flag open questions.
- Shares the **server-SDK trusted path** with Phase 05 (monetization). Consumes `session_id` from the envelope but imposes no session semantics; no per-session economy rollup in v1 (results-only).

---

## Design

*Design layer per Foundation §8.3 — additions only. The backbone (envelope, skew correction, 48 h seal, write-ahead raw ordering, dedup gates, absolute-value flush, read-merge) is Foundation §1–4 and is not restated. Day = corrected UTC day everywhere (Foundation §4.2).*

### ER / data model

**Three durable structures, all owned by 03 (Foundation §5).** Two result tables + the one tier-3 spine touch (Foundation §1.3).

| Entity | Class | Key (grain) | Non-key attributes | Cardinality bound |
|---|---|---|---|---|
| `ECONOMY_FLOW_RESULT` (Foundation §1.2, grain refined — below) | **Result table** — day cells, seal-governed, rebuildable from the raw floor | `game_id × currency × utc_day × provenance × reason × flow_type` | `amount_sum` (running absolute) | per game×day ≤ #currencies × 2 (provenance) × 2 (flow) × #observed-reasons |
| `ECONOMY_FLOW_SEGMENT_RESULT` (the "(+ segmented)" sibling in Foundation §5) | **Result table**, optional rows | base grain + `segment_dim × segment_value` | `amount_sum` | observed segments only; **independent per-dim axes, never cross-dim combos** (below) |
| `BALANCE_SNAPSHOT` (Foundation §1.2 / §1.3 tier-3 opt-in) | **Spine touch** — per-user state, NOT seal-governed | `game_id × user_id × currency` | `last_known_balance`, `as_of` (corrected event-time of last writer), `provenance` (of last writer) | users × balance-reporting currencies; written only while `economy_depth_capture_mode` on |
| `ECONOMY_SUPPLY_DAY` (Q5, ratified 2026-07-17 — the fourth durable structure) | **Snapshot row** — write-once at day-seal; a third class beside result cells and spine touches | `game_id × currency × utc_day` | `money_supply` (Σ `last_known_balance`), depth percentiles (e.g. `p50`/`p90`), `n_users` (balance-reporting user count — supply rises merely when more users report), optional trusted-only supply (server-provenance slice; advisory) | games × balance-reporting currencies × days; one row each; written only while `economy_depth_capture_mode` on |

**Provenance rides the key (decision).** `provenance ∈ {server, client}` is an extra key dimension on both flow grains, **derived at ingest from the class of the authenticating credential** per Foundation §4.5 (amendment landed: `GAME.sdk_key` = client scope, `GAME.server_credential` = server scope) — same derivation posture as `game_id` (Foundation §1.1); a body-supplied flag is ignored. Trusted-only totals = the `server` slice; headline totals = the provenance-collapsed read (same collapse shape as §2's reason-collapse). **Tradeoff:** ×2 worst-case cell fan-out, vs. the rejected separate trusted-only accumulator, which costs a second increment per server event, a second structure that can drift, and a read-time reconciliation anyway. **[OPEN — contingent]** Per Foundation §4.5/§9.5: if the F-3 envelope/key-class decision (metrics sheet §7) leaves server keys indistinguishable, provenance defaults to `client` (conservative: untrusted unless proven).

**Segment axes are independent (decision).** `segment_dim ∈ {level_bucket, region}`; each axis accumulates on its own rows — no (level × region) cross-product. Bounds segmented cardinality to a *sum* of small axes (`level_bucket_boundaries` bucket count + observed regions), not a product; cost: no simultaneous two-dim slice in v1 (consistent with §4 "kept bounded"). `level_bucket` is computed at ingest from `player_level` via `level_bucket_boundaries` (bucket label stored, raw level never stored; forward-only per §6). An event missing a dim contributes nothing to that axis; `reason` is retained inside segments, with the metrics-sheet fallback (collapse reason within segments) as the scale lever if cardinality bites.

**Result vs spine touch.** The two flow tables are pure results: mutable until seal via absolute-value flush, immutable after, reconstructible from the raw day files. `BALANCE_SNAPSHOT` is tier-3 per-user truth: **day-less**, so its mutability is governed by `as_of` last-writer-wins, not by the day-seal — though sealed-late events can never touch it (they stop at Foundation §3.1 step 5). It is the only per-user draw this story makes; the core flow metrics need zero per-user state (§4 ✓).

**Grain-refinement flag — resolved (amendment landed).** Foundation §1.2 now carries the `provenance` key on `ECONOMY_FLOW_RESULT` and `as_of` (the LWW guard) on `BALANCE_SNAPSHOT`, exactly as this design requested. The remaining story-level refinements are the advisory non-key `provenance` on `BALANCE_SNAPSHOT` and the `ECONOMY_FLOW_SEGMENT_RESULT` sibling (both within Foundation's "key attributes only" latitude; assembled in [ER-full.md](ER-full.md)).

```mermaid
erDiagram
    GAME ||--o{ ECONOMY_FLOW_RESULT : ""
    GAME ||--o{ ECONOMY_FLOW_SEGMENT_RESULT : ""
    USER_SPINE ||--o{ BALANCE_SNAPSHOT : "tier-3 opt-in"
    ECONOMY_FLOW_RESULT {
        id   game_id PK, FK
        text currency PK
        date utc_day PK
        text provenance PK "server|client, SDK-key-derived"
        text reason PK
        text flow_type PK "source|sink"
        num  amount_sum
    }
    ECONOMY_FLOW_SEGMENT_RESULT {
        id   game_id PK, FK
        text currency PK
        date utc_day PK
        text provenance PK
        text segment_dim PK "level_bucket|region"
        text segment_value PK
        text reason PK
        text flow_type PK
        num  amount_sum
    }
    BALANCE_SNAPSHOT {
        id   game_id PK, FK
        id   user_id PK, FK
        text currency PK
        num  last_known_balance
        ts   as_of "corrected time of last writer"
        text provenance "of last writer; advisory"
    }
```

(`GAME`, `USER_SPINE` are referenced Foundation §1.2 entities, attributes omitted.)

### Redis structures

Keys per the Foundation §2.1 grammar; owned domain tags **`eco`** and **`bal`**. Types from the §2.2 palette; TTLs per §2.3.

| Key | Type | Field → value | TTL | Durability class |
|---|---|---|---|---|
| `{game_id}:eco:{logical_day}` | hash | cell tuple `(provenance, flow_type, currency, reason)` → running absolute `amount_sum` | ~72 h from day end | **flushes → class M** (Foundation §3.2.1): amounts are `+=`-only, `GREATEST` + `HSETNX` seed |
| `{game_id}:eco:{logical_day}:seg` | hash | `(provenance, flow_type, currency, segment_dim, segment_value, reason)` → absolute sum | ~72 h from day end | **flushes → class M** → `ECONOMY_FLOW_SEGMENT_RESULT` (same sweep) |
| `{game_id}:bal:{currency}` | hash | `user_id` → `(last_known_balance, as_of, provenance)` | none (rebuildable from durable snapshot) | **flushes → class L** (Foundation §3.2.1): `BALANCE_SNAPSHOT` via `as_of`-guarded upsert-latest; exists only when depth on |
| `{game_id}:bal:dirty` | set | `user_id:currency` entries touched since last flush | cleared by each flush | **transient-and-losable** (worst case: one redundant no-op flush) |
| `{game_id}:eco:cur` | set | observed currency ids (auto-registration; allowlist/cap gate; dashboard picker) | none | **transient-and-losable** — rebuild = distinct currencies in `ECONOMY_FLOW_RESULT` |

- **Field encoding.** `currency` and `reason` are free-form and legitimately contain `:` (`shop_purchase:sword`) — hash fields are tuple-encoded with an escaped separator so the flusher round-trips fields to cell keys unambiguously. (Exact encoding is an implementation detail; unambiguity is the requirement.)
- **Durable-immediate: none.** 03 owns no Foundation §3.1 step-7 write — economy is not money; nothing bypasses the flush.
- **`ECONOMY_SUPPLY_DAY`: no new Redis.** The seal-time snapshot is a direct read of the durable `BALANCE_SNAPSHOT` rows (post-flush) at the capture moment → one write-once Postgres row per game×currency×day; the percentile scan reuses the same bucketed-histogram scale lever as the current depth read. No hot key, no open-day bucket (a day acquires its supply row only at seal; "current supply" stays the live `BALANCE_SNAPSHOT` read).
- **No zsets.** Top-faucet/top-drain ranking is display-time only (Foundation §2.2, §3.3); nothing ranked is stored.
- **`bal` loss posture.** An entry lost before flush forfeits ≤ one flush window of balance updates (accepted, Foundation §6; depth is advisory). Per-entry rehydrate-on-miss (next section) guarantees a post-crash write can never regress the durable snapshot.
- **Dedup markers** (`{game_id}:dedup:{event_id}`, 24 h) are 01's shared front door (Foundation §4.1) — economy rides them, owns nothing there.

### Worker / pipeline flow

Additions to Foundation §3.1 only; unnamed steps are unchanged.

**Step 3 — strict `economy` payload validation (Foundation §4.4 quarantine rule).** Applies to `kind = economy` and to reserved-name collisions (a free-form event *named* `economy` routes here via 01's kind-routing). Any required-field failure ⇒ quarantine-mark + `quarantined_typed` tally + raw append (step 4) + stop:

| Check | Valid | Invalid ⇒ |
|---|---|---|
| `flow_type` | exactly `source` or `sink` | quarantine |
| `currency_type` | non-empty string | quarantine |
| `amount` | finite numeric, strictly > 0 — direction never by sign; negatives are **not** auto-flipped | quarantine |
| `reason` | non-empty string | quarantine |
| allowlist (when `economy_currency_allowlist` non-empty) | currency ∈ list | quarantine (config gate treated as typed validation; forward-only) |
| currency cap (accept-all posture, §H-4 applied to currencies) | currency already registered or under cap | **drop-and-tally `capexceeded`**, not raw-appended — mirrors Foundation §4.4's name-cap class |

Optional fields fail field-level, never event-level: `balance_after` non-numeric or `< 0` ⇒ discard the field (not clamped to zero, not quarantined — the event still accumulates flows); absent player context just skips that segment axis. Provenance is derived here from the credential class (Foundation §4.5; ER decision above), before any counting.

**Step 7 — no additions.** Economy makes zero durable-immediate writes. (No `first_seen` seed runs for an economy event — Q1, 2026-07-17: only 02's first-session path seeds the spine. Consequence for depth, below: a `BALANCE_SNAPSHOT` may be written for a user with **no** `USER_SPINE` row — the association is logical, not an enforced FK; the balance row stands on its own and the `first_seen` (if any) arrives later via a session.)

**Step 8 — hot updates, in order:**
1. `SADD` the currency into `{game_id}:eco:cur` (auto-registration under accept-all).
2. Increment the base cell in `{game_id}:eco:{corrected_day}` — rehydrate-on-miss first (Foundation §2.3: seed the day's bucket from Postgres absolutes).
3. For each **present** segment dim: increment the matching `:seg` cell (observed segments only materialize).
4. If depth on **and** a valid `balance_after`: guarded LWW upsert into `{game_id}:bal:{currency}` field `user_id`; add the entry to `bal:dirty`.

**LWW by corrected time under out-of-order arrival (the depth design).** Three guards make "last writer by corrected event-time" hold across reordering, retries, and Redis loss:
1. **Hot guard** — overwrite the hash entry only if incoming `corrected_time ≥` stored `as_of`. On entry miss, **rehydrate-on-miss per entry**: one durable point-read of `BALANCE_SNAPSHOT` seeds `(balance, as_of, provenance)` before comparing (no row = accept incoming). Without this seed, a stale offline-buffered event arriving after a Redis crash could clobber a newer durable balance.
2. **Flush guard** — the flusher sweeps `bal:dirty` and performs a **guarded absolute upsert-latest**: apply `(last_known_balance, as_of, provenance)` only where incoming `as_of ≥` the durable row's `as_of`. A retried or duplicated flush writes identical absolutes ⇒ no-op by construction, preserving Foundation §3.2 idempotency.
3. **Tie-break** — equal `as_of` ⇒ later `server_received_time` wins, then greatest `event_id`. Deterministic and arrival-order-independent.

The LWW domain is bounded by the seal: a sealed-day event stops at step 5 and never touches `bal`, so only corrected times within open days compete.

**Idempotency & dedup.** Economy dedups by windowed `event_id`, 24 h, at step 6 (Foundation §4.1) — **no `transaction_id` path exists; economy is not money**. Step-8 increments are not idempotent by themselves; the dedup gate is the only per-event guard. Accepted residual (§5's bridge note): a retry landing **> 24 h** later re-counts the flow into its (still-open) corrected-day cell; the same duplicate is harmless to `bal` (identical `corrected_time` + balance ⇒ tie-break overwrite with equal values). The flush path itself stays idempotent (absolute values, Foundation §3.2).

**Seal / late.** Nothing beyond the backbone: the final flush at `D_end + 48 h` freezes that day's flow cells; late economy events quarantine at step 5 (`sealed_late` tally); no bucket is ever recreated. `bal` / `BALANCE_SNAPSHOT` has no seal — see LWW above.

### API / contract surface

**Ingest (write side).** Canonical envelope per Foundation §1.1 with `kind = economy`; the `props` payload contract (violations per the step-3 table; drop-vs-quarantine per Foundation §4.4):

| Field | Req | Contract |
|---|---|---|
| `flow_type` | ✔ | `source` \| `sink` — nothing else valid |
| `currency_type` | ✔ | non-empty string; per-game namespace; currencies independent, never cross-currency-summed |
| `amount` | ✔ | numeric > 0; magnitude only — direction is `flow_type`'s |
| `reason` | ✔ | non-empty string; drives the faucet/drain breakdown |
| `balance_after` | – | numeric ≥ 0; feeds depth only; invalid ⇒ field discarded, event still counts |
| `player_level`, `region`, … | – | segmentation context; `player_level` → `level_bucket` at ingest |
| provenance | *(derived)* | `server` \| `client` from the authenticating credential class (Foundation §4.5); any body-supplied value ignored |

**Read model (dashboard API).** All reads per game × currency; sealed days from Postgres, open days live-merged from the `eco` buckets with last-flush fallback and a provisional marker (Foundation §3.3). Every derived figure is a read-time computation — never stored:

| Read | Over | Computation |
|---|---|---|
| source / sink daily series | base cells | collapse `provenance` + `reason` |
| net flow | same | `total_source − total_sink` |
| sink ratio | same | `total_sink / total_source`; **N/A when `total_source = 0`** (and 0/0 → N/A, never 0 or ∞ or NaN). **Low-volume guard (added 2026-07-17):** when either leg is below `economy_ratio_min_events` (default 100), the ratio is annotated "low volume — unreliable" (a 3/1 = 300 % reading off 4 events is noise, not deflation). `net_flow` (always defined) is the **primary** balance metric; sink_ratio is the fragile secondary. An optional symmetric bounded form `(sink − source)/(sink + source)` ∈ [−1, +1] is offered as a stable alternative view. |
| top faucets / top drains | per-reason cells | sort desc per flow_type, take `economy_top_n_reasons` (retroactive knob — pure re-rank) |
| trusted-only variant of all above | `provenance = server` slice | identical computations |
| segment slice | segment cells for one `(segment_dim, segment_value)` | identical computations |
| money_supply / depth pXX (current) | `BALANCE_SNAPSHOT` durable rows | Σ / percentiles over `last_known_balance` |
| money-supply trend (day-over-day) | `ECONOMY_SUPPLY_DAY` rows (Q5) | plain select of `money_supply` / percentiles per day; optionally overlay query-time `SUM(net_flow) OVER (ORDER BY utc_day)` over `ECONOMY_FLOW_RESULT` — divergence between the two lines is diagnostic |

- **Depth caveats (surfaced in the UI):** point-in-time and ≤ one flush window stale — `bal` is day-less, so Foundation §3.3's open-day Redis merge doesn't apply; the durable snapshot is read directly. Covers balance-reporting users only; advisory unless `provenance = server`; trusted-only money supply (Σ over rows whose *last* writer was server) is approximate when client events overwrite server-written balances. Percentiles are a per-currency scan — indie-scale fine; a bucketed histogram is the named scale lever.
- **Dormant-holder undercount (clarified 2026-07-17).** `BALANCE_SNAPSHOT` is **upsert-latest and persistent** (day-less, never pruned) — so `money_supply = Σ last_known_balance` is a Σ over **every user who has *ever* reported a balance**, carried forward from their last balance event — **not** only users active in the snapshot window. This is the correct stock-over-all-known-holders definition; a user who stockpiled currency and went quiet still contributes their last-known balance. The residual undercount is confined to holders who *never once* emitted a `balance_after` (depth-off periods, or currencies a client never reports balances for) — surfaced by **`n_users`** (the balance-reporting holder count) on `ECONOMY_SUPPLY_DAY`, so coverage is visible, and by the **supply-vs-cumulative-flow divergence** diagnostic (Q5): a persistent gap between measured supply and `Σ net_flow` flags untracked/unreported holdings. The dashboard labels supply "over N balance-reporting holders," never as an unqualified total.
- **Money-supply trend — RESOLVED (2026-07-17, Q5): ratify `ECONOMY_SUPPLY_DAY` as a daily balance-derived snapshot.** §2's health read ("rising money supply day-over-day") needs a supply-*level* history, which `BALANCE_SNAPSHOT` (upsert-latest) destroys every day — so it is **capture-it-or-lose-it** and earns its one-row-per-game×currency×day. **Snapshot the balance-derived level** (Σ `last_known_balance` + percentiles + `n_users`) at day-seal, gated on `economy_depth_capture_mode`; it is rebuildable in principle from the raw floor (replay `balance_after` LWW to any day boundary), days-while-depth-off unrecoverable (forward-only, same posture as depth). **Do NOT store cumulative sources−sinks** (the literal Q5 phrasing): that stays a query-time window function (`SUM(net_flow) OVER (ORDER BY utc_day)`) over `ECONOMY_FLOW_RESULT` — trivial at ~1000 day-rows — because cumulated flow is an index of change, not a level (it starts at zero at instrumentation start and absorbs every accepted residual). The read model overlays the two lines: **divergence between measured supply and cumulative-flow-implied supply is itself diagnostic** of untracked/spoofed/client-only flows (the EVE Online MER precedent, where the two diverged 9 % for three months). Capture-moment (at-seal reusing the seal sweep vs at-rollover) is a plan-time detail; at-seal is the lower-machinery option and matches the "as of seal" labeling. *Sources: EVE Online Monthly Economic Report (separate Money-Supply level vs Sinks/Faucets flow charts + `money_supply.csv`) · The Nosy Gamer Nov-2025 MER analysis (9 % flow-vs-level divergence) · Roblox economy dashboard ("Average wallet balance" level trend) · NetEase GDC 2020 inflation-monitoring (tracks stock alongside flows) · Postgres window-function running-total practice.*

### Relations with other stories

- **Owns:** `ECONOMY_FLOW_RESULT` + `ECONOMY_FLOW_SEGMENT_RESULT`, `BALANCE_SNAPSHOT`, `ECONOMY_SUPPLY_DAY` (Q5, snapshot-at-seal), Redis domains `eco` + `bal` (Foundation §5, row 03).
- **Writes (shared):** none. Catalog, day-count, and `EXCEPTION_TALLY` effects of economy events (`quarantined_typed`, `sealed_late`, `capexceeded`) are written by 01's shared front-door machinery; 03's validation only selects the outcome.
- **Reads:** `GAME.config` (§6 knobs incl. shared `level_bucket_boundaries`); 01's dedup front door (step 6); `USER_SPINE` (existence only — FK parent of `BALANCE_SNAPSHOT`); envelope `session_id` / `user_id` as context — no session semantics, no per-session economy rollup in v1.
- **Feeds:** the dashboard read model only. No story consumes economy results in v1 (06 reads monetization, not economy; a premium-purchase ↔ gem-faucet correlation view would be a cross-story read, out of v1 scope).
- **Ordering / lifecycle:** 01's substrate precedes everything (auth → `game_id` + `provenance` from the credential class, write-ahead, dedup). **No spine-parent guarantee (Q1, 2026-07-17):** economy events no longer trigger a `first_seen` seed, so a `BALANCE_SNAPSHOT` write may occur for a user with no `USER_SPINE` row — the parent is a logical association, not an enforced FK; depth is advisory and the balance row stands alone. Flow cells follow the §2.3 open→seal lifecycle; `BALANCE_SNAPSHOT` is LWW-governed with no seal. Forward-only levers: `economy_currency_allowlist`, `level_bucket_boundaries`, depth enablement (no backfill; disabling depth stops writes but keeps rows — staleness visible via `as_of`).
- **Flagged bridges:** **server-provenance / trusted-path (03 ↔ 05) — folded into Foundation §4.5** (amendment landed; **F-3 resolved 2026-07-17, Q2**): one credential-class derivation (public `sdk_key` client / secret `server_credential` server; two-class model, phase 10), never body-trusted. Both stories now cite that section; no bridge file exists or is needed.
