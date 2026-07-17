# Phase 11 — Implementation Tasks: Panel (Operator Dashboard)
**Source spec:** `phases/11-panel-design.md` · **Design deps:** `phases/00-foundation.md` (§1.2, §3.3 read model, §4.5 credential classes, §5 ownership), `phases/10-operator-admin.md` (operator accounts, credential lifecycle, config-effective-time, admin API), `phases/00.5-ops-envelope.md` (erasure/access jobs, rate-limit tallies), every phase 01–07 `§6 Configurations` + `## Design` read-model surfaces, `spec.md` FR-025/FR-026/FR-002/FR-017, SC-003/SC-009 · **Status:** task-list draft (2026-07-17)

## 0. Scope & dependencies

This phase builds the **server-rendered operator dashboard ("the Panel")** — a NestJS MVC module (`src/panel/`) that is embedded inside the same NestJS process as ingest/workers/dashboard API (11 §1; `spec.md` §Q "Dashboard + deploy"). It adds no new stored data, no envelope field, no `kind`, and no worker path: it is pure presentation over the read model that phases 01–10 already produce. It comprises the Nunjucks + Tailwind + HTMX + Alpine.js + Chart.js rendering stack (11 §1, §4, §5), the layout system (11 §2), an auth gate reusing phase 10's operator control plane (11 §7; 10 §Account security), the read-model consumption merge (Foundation §3.3 — sealed from Postgres, open from Redis with last-flush fallback), and every view in the inventory (11 §3: auth, game management, dashboard overview, economy, retention, monetization, sessions, config admin + audit, ops cold-storage/exceptions/erasure, operator accounts).

**Ordering / prerequisites (README dep table):** phase 11 is the last phase; its dep column is "01–10, 00.5". Every result structure it reads (Foundation §5 ownership matrix) and every admin/registry entity it operates over (phase 10) must exist first. Nothing depends on 11 (it is the human-facing leaf — README: dep "— (presentation)"). The panel is READ-only on all metric results and drives writes only through phase 10's admin API + phase 00.5's erasure/access job triggers — it owns no structure in Foundation §5.

**FR/SC this phase is accountable for:**
- **FR-025** — present per game: live event counts, economy (sink/source), retention (D1/D7/D30), segmented monetization.
- **FR-026** — read live figures from Redis, historical results from Postgres (the Foundation §3.3 merge, made visible in the UI).
- **FR-002 / SC-003** — no dashboard view crosses game boundaries (every game-scoped route is `GameAccessGuard`-scoped; zero cross-contamination).
- **FR-017** — retention shown as classic Day-N, explicitly labelled, immature cohorts masked as N/A.
- **SC-009** — panel is part of the single `docker-compose up` (no separate front-end app/build server; one NestJS process).
- Surfaces (does not own) FR-024 cold-storage status, FR-027 config knobs, and the phase-00.5 GDPR erasure/access flows.

---

## 1. Task list

### A. Module scaffold & rendering stack (11 §1, §5, SC-009)

- [ ] **T-11.1** Create the `src/panel/` NestJS module (`panel.module.ts`) registering all sub-controllers, guards, and static serving — *cite:* 11 §1 tree. One top-level module; no separate app.
- [ ] **T-11.2** Configure NestJS MVC to resolve Nunjucks (`.njk`) as the view engine with the `views/` root and template inheritance (blocks/includes/macros) enabled — *cite:* 11 §1 (Rendering row), §2. (after T-11.1)
- [ ] **T-11.3** Register `ServeStaticModule` (or `@nestjs/serve-static`) to serve `src/public/` at `/assets/*` (css, js, img) — *cite:* 11 §1, §5.1 (CSS referenced as `/assets/css/tailwind.css`). (after T-11.1)
- [ ] **T-11.4** Define the panel route namespace: all routes under `/panel/*`, ingest path `/v1/events` untouched — *cite:* 11 §1 (Routing convention). Verifies no collision with the pinned ingest path (Foundation §1.1).
- [ ] **T-11.5** Add the four platform-level panel knobs to the config surface consumed at render time: `panel_live_poll_interval_sec` (30), `panel_chart_color_primary`, `panel_logo_url`, `panel_title` — *cite:* 11 §10. Platform-level, not per-game; read via phase 10 config service.

### B. Asset pipeline (11 §5, §6.1)

- [ ] **T-11.6** Set up the Tailwind CSS v4 build step (`npm run build` / `docker-compose build`): input CSS uses `@import "tailwindcss"` + `@source` directives pointing at `views/` and `public/js/`; output minified to `src/public/css/tailwind.css` — *cite:* 11 §5.1.
- [ ] **T-11.7** Encode the design-system palette + component utility patterns as documented Tailwind classes (indigo/emerald/red/amber/slate; button/card/badge/table/input/skeleton patterns) — *cite:* 11 §6.1 (Components table). No JS component layer; utility classes only.
- [ ] **T-11.8** Pin CDN `<script defer>` tags for HTMX, Alpine.js, Chart.js in the layout `<head>`, versions pinned; document the local-vendor path swap for air-gapped/sanctioned deploys — *cite:* 11 §5.2.
- [ ] **T-11.9** Author `views/partials/icons.njk` as a Nunjucks macro set of inline SVGs (sidebar/action/status icons enumerated in §5.3) — *cite:* 11 §5.3. No icon-library dependency (sanctions constraint).
- [ ] **T-11.10** Author `src/public/js/panel.js` (vanilla): Chart.js init on `DOMContentLoaded` + `htmx:afterSwap`, clipboard-copy helper, and any small helpers — *cite:* 11 §4.3, §5.2. (after T-11.8)

### C. Layout system & shared partials (11 §2, §6.2–§6.4)

- [ ] **T-11.11** Build `views/layouts/auth.njk` — minimal centered-card layout on dark background, no sidebar/topbar — *cite:* 11 §2.1.
- [ ] **T-11.12** Build `views/layouts/panel.njk` — fixed collapsible sidebar + sticky topbar + scrollable `#content` block, footer (version/docs/build hash) — *cite:* 11 §2.2.
- [ ] **T-11.13** Build `partials/sidebar.njk` — nav items, game-name sticky header on game-scoped routes, active-state highlight, `admin`-only "Accounts" item (server-gated) — *cite:* 11 §2.2 (Sidebar behavior), §7.3. (after T-11.12)
- [ ] **T-11.14** Build `partials/topbar.njk` + `partials/game-selector.njk` — hamburger toggle (Alpine), breadcrumb, HTMX game-selector dropdown (populated from operator-accessible games, with search), operator dropdown (account/logout) — *cite:* 11 §2.2 (Top bar). (after T-11.12)
- [ ] **T-11.15** Build reusable partials: `metric-card.njk` (label/value/trend/provisional badge), `period-selector.njk` (24h/7d/30d/90d/custom), `chart-fragment.njk` (canvas + `data-chart-config`), `empty-state.njk`, `error-alert.njk` (retry via `hx-get`), `confirm-modal.njk` (Alpine type-to-confirm) — *cite:* 11 §1 tree (partials), §2.2, §4.3, §6.3, §6.4.
- [ ] **T-11.16** Implement the flash-message system: server sets flash via session, template renders dismissible banners (success/error/warning/info) with Alpine `x-show` + 5s auto-dismiss — *cite:* 11 §6.2.
- [ ] **T-11.17** Wire the HTMX SPA-navigation contract in the layout: sidebar links use `hx-get` + `hx-target="#content"` + `hx-push-url="true"`; full page load renders the whole layout server-side, partial swaps render only `#content` — *cite:* 11 §2.2 (Content area), §4.1 (Navigation). (after T-11.12)

### D. Auth gate — reusing the phase-10 operator control plane (11 §3.1, §7; 10 §Account security)

- [ ] **T-11.18** Implement `panel/auth/auth.service.ts`: password verify, TOTP MFA check, failed-login count + lockout, session create — reading/writing `OPERATOR_ACCOUNT` (owned by phase 10) via phase 10's admin service — *cite:* 11 §1 tree, 10 §ER (`OPERATOR_ACCOUNT`), 10 §Account security. Panel does NOT redefine account semantics; it consumes phase 10.
- [ ] **T-11.19** Implement server-side session store (express-session or equivalent over Redis/Postgres), cookie `HttpOnly` + `Secure` (TLS) + `SameSite=Lax`, TTL = `operator_session_timeout_min` (default 120), refresh-on-activity — *cite:* 11 §7.1; knob owned by phase 10 §6.
- [ ] **T-11.20** Implement `panel/auth/auth.guard.ts` (`AuthGuard`): read `operator_id` from session, load `OPERATOR_ACCOUNT`, attach `req.operator`, enforce role; on missing/expired session return 401 → client redirect to `/panel/login` — *cite:* 11 §7.1, §7.3. Apply to all `/panel/*` routes except login/MFA.
- [ ] **T-11.21** Implement the role-enforcement decorator (`admin`-only marker): `viewer` operators get 403 + flash "Admin access required" on config-write, credential-management, operator-management, and erasure/access-submit routes — *cite:* 11 §7.3; 10 §ER (`role admin|viewer`, enforced).
- [ ] **T-11.22** Implement `GameAccessGuard`: extract `gameId` param, load `GAME` from Postgres (phase 01 registry via phase 10 read path), attach `req.game`, 404 if absent; no per-game permission model in v1 — *cite:* 11 §7.2; Foundation §5 (`GAME` owned by 01, direct read). This guard enforces FR-002/SC-003 game isolation.
- [ ] **T-11.23** Build `auth/login.njk` + `auth.controller.ts` (GET/POST `/panel/login`, `/panel/logout`): HTMX POST, success → `/panel/games`, failure → inline error swap, lockout timer message (Alpine countdown) after `operator_login_max_attempts` — *cite:* 11 §3.1 (`login.njk`), §7; knobs from 10 §6.
- [ ] **T-11.24** Build `auth/mfa-setup.njk` + `mfa.controller.ts` (GET/POST `/panel/mfa`): QR data-URI from server TOTP URI + manual key copy, 6-digit verify (HTMX POST), skip-link when `operator_mfa_required=false` — *cite:* 11 §3.1 (`mfa-setup.njk`); knob from 10 §6.

### E. Read-model consumption service (Foundation §3.3, §5; FR-026)

- [ ] **T-11.25** Implement the shared **read-model merge** in `dashboard.service.ts`: for a requested day range, read **sealed days from Postgres only**, **open days (today + 48h grace) live from Redis buckets with fallback to last-flushed Postgres value** when a bucket is missing (post-crash), and mark any period including today "provisional" — *cite:* Foundation §3.3, §2.3 (open-day lifecycle); 11 §8 (Read model). This is the single uniform merge; per-view services state *what* they read, never a new merge rule.
- [ ] **T-11.26** Implement read-time derived computations (never stored): rankings/top-N, ratios (sink ratio, stickiness DAU/MAU, ARPU/ARPDAU/ARPPU, D_N), and previous-period trend deltas — *cite:* Foundation §3.3 (rankings/ratios are read-time), 11 §3.3 (trend logic). Trend `—` if <1% change (11 §3.3).
- [ ] **T-11.27** Wire per-domain Redis bucket reads to the Foundation §2.1 key grammar + owned domain tags (`cnt`/`cat`, `sess`/`act`, `eco`/`bal`, `ret`, `mon`/`payer`/`rev`) — read-only; the panel is never a writer of any bucket — *cite:* Foundation §2.1, §5 (open-day buckets read by "read model"). (after T-11.25)
- [ ] **T-11.28** Surface `CONFIG_AUDIT.effective_from` era boundaries into the read-model so dimension/FX-era caveats render (monetization "% context", economy provenance labels) — *cite:* 10 §API (config-era boundaries feed metric read-models), 11 §3.6.

### F. Chart.js integration (11 §4.3)

- [ ] **T-11.29** Implement `chart-fragment.njk` emit + the `htmx:afterSwap`/`DOMContentLoaded` re-init in `panel.js`: each `<canvas>` carries `data-chart-config` (JSON-stringified Chart.js config); the initializer parses it and calls `new Chart(canvas, config)` — *cite:* 11 §4.3 (Initialization pattern). (after T-11.10, T-11.15)
- [ ] **T-11.30** Add a `GET …/chart` sub-route pattern to each metric controller returning **only** the chart HTML fragment (canvas + serialized config), so HTMX lazy-loads it into a skeleton placeholder on `hx-trigger="load"` — *cite:* 11 §3.3, §4.1 (Lazy chart loading), §4.3 (Server-side chart endpoints).
- [ ] **T-11.31** Encode the chart-design-system defaults (Chart.defaults.font = system-ui stack; subtle grid lines; `responsive:true, maintainAspectRatio:false`; custom HTML tooltips; palette indigo/emerald/red/amber with `panel_chart_color_primary` override) — *cite:* 11 §4.3 (Chart design system), §10 (`panel_chart_color_primary`). (after T-11.10)

### G. View — Game management (11 §3.2; 10 credential lifecycle)

- [ ] **T-11.32** Build `games/list.njk` + `games.controller.ts` GET `/panel/games` (login landing): table (Name, Daily Events HTMX-polled badge, Status, Open link), client-side search (Alpine), empty state, inline "Register Game" form (Alpine `x-show` → HTMX POST → redirect to detail showing issued key) — *cite:* 11 §3.2 (`list.njk`); registration flow = 10 §Credential lifecycle (auto-issue one `sdk_key`).
- [ ] **T-11.33** Build `games/detail.njk` GET `/panel/:gameId/settings` — SDK Key card (prefix + copy, created/last-used HTMX-polled 60s, Rotate = new key inline / old stays active, Revoke = `confirm-modal` type "REVOKE" with the "shipped builds go dark" warning) — *cite:* 11 §3.2 (`detail.njk` SDK Key card); 10 §Credential lifecycle (client `sdk_key` rotation ≥2 active; revoke is emergency, UI must state it).
- [ ] **T-11.34** Add the Server Credentials card to `detail.njk`: table (prefix/created/last-used/status), "Create Server Credential" → HTMX POST → redirect to `credential-show.njk`, per-credential Rotate (dual-active) + Revoke (confirm-modal) — *cite:* 11 §3.2 (Server Credentials card); 10 §Credential lifecycle (server credential 1..N, dual-active rotation, show-once). (after T-11.33)
- [ ] **T-11.35** Add the Quick Stats card to `detail.njk`: mini metric cards (DAU, MAU, Events 24h, Total Sessions 24h) HTMX-polled 30s, current-day marked "provisional", link to full dashboard — *cite:* 11 §3.2 (Quick Stats); read-model merge (T-11.25). (after T-11.33)
- [ ] **T-11.36** Add Retire Game footer action to `detail.njk`: distinct red/outline button, confirm-modal ("Retiring stops ingestion but preserves data / cold storage continues"), HTMX POST `/panel/:gameId/settings/retire`; retired-game state disables create/rotate/revoke while keeping data visible — *cite:* 11 §3.2 (Retire Game, retired-game state); 10 §Credential lifecycle (retire = disable ingest, no data delete). (after T-11.33)
- [ ] **T-11.37** Build `games/credential-show.njk`: one-time credential display guarded by a short-lived Redis flag `credential:show:{credential_id}:{operator_id}` (5-min TTL); absent flag → redirect to detail with "no longer available" flash; value never re-rendered or stored in session; "I've saved this" ack button — *cite:* 11 §3.2 (`credential-show.njk`); 10 §Credential lifecycle (shown once, stored hashed).

### H. View — Dashboard overview (11 §3.3; FR-025)

- [ ] **T-11.38** Build `dashboard/index.njk` + `dashboard.controller.ts` GET `/panel/:gameId` with `period-selector` (HTMX GET `?period=` swaps all cards+charts) — *cite:* 11 §3.3 (Period selector); route convention 11 §1.
- [ ] **T-11.39** Render the 8-card KPI row (DAU, MAU, Stickiness, ARPDAU, Events 24h, Sessions 24h, Revenue period, ARPPU) with trend arrows vs preceding equal-length period + provisional badge when period includes today — *cite:* 11 §3.3 (KPI cards row), §3.3 (trend logic); derived via T-11.26. Reads phase 02/05/06 results (Foundation §5).
- [ ] **T-11.40** Add the Event Activity line chart (lazy HTMX `hx-trigger="load"` → chart fragment) — daily event count over period — *cite:* 11 §3.3 (Event Activity chart), §4.3 chart-types table (`line`). Reads `EVENT_DAY_COUNT` (phase 01, Foundation §5). (after T-11.30)
- [ ] **T-11.41** Add the Top Events table (server-rendered, Event Name | Count | % of Total, limited to `top_n_events`) — *cite:* 11 §3.3 (Top Events); knob `top_n_events` owned by 01. Reads `EVENT_CATALOG`/`EVENT_DAY_COUNT`.
- [ ] **T-11.42** Add the Latest Exceptions card summarizing today's `EXCEPTION_TALLY` rows + link to ops exceptions — *cite:* 11 §3.3 (Latest Exceptions); reads `EXCEPTION_TALLY` (phase 01, Foundation §5).
- [ ] **T-11.43** Implement per-section states for the overview: with-data, empty-state per section, skeleton loading, per-section error-alert with retry — *cite:* 11 §3.3 (States). (after T-11.15)

### I. View — Economy (11 §3.4; FR-025)

- [ ] **T-11.44** Build `metrics/economy.njk` + `economy.controller.ts` GET `/panel/:gameId/economy` with period selector + currency dropdown (populated from `{game_id}:eco:cur`, "All Currencies" aggregate, HTMX swap on change) — *cite:* 11 §3.4 (Period + Currency selectors). Reads `ECONOMY_FLOW_RESULT` (phase 03, Foundation §5).
- [ ] **T-11.45** Add the Net Flow dual-area line chart (green sources / red sinks / dotted net, Y starts at 0) — *cite:* 11 §3.4 (Net Flow chart), §4.3 chart-types (`line` dual). (after T-11.30)
- [ ] **T-11.46** Add economy summary cards: Total Sources, Total Sinks, Net Flow, Sink Ratio (Sinks/Sources×100, N/A when Sources=0) — *cite:* 11 §3.4 (Summary cards). Sink ratio is a read-time computation (T-11.26).
- [ ] **T-11.47** Add Top Faucets / Top Drains side-by-side ranked tables (Rank/Reason/Amount/%), limited to `economy_top_n_reasons`, color-coded green/red — *cite:* 11 §3.4 (Top Faucets/Drains); knob owned by 03.
- [ ] **T-11.48** Add the Currency Breakdown horizontal stacked/progress bars per currency (name, proportional bar, %) — *cite:* 11 §3.4 (Currency Breakdown), §4.3 chart-types (`bar` horizontal stacked). (after T-11.30)
- [ ] **T-11.49** Add the Money Supply dual-line trend (measured vs cumulative-flow-implied) shown only when `economy_depth_capture_mode` on, labelled with holder cohort — *cite:* 11 §3.4 (Money Supply); reads `ECONOMY_SUPPLY_DAY` (phase 03, Foundation §5); knob owned by 03. (after T-11.30)
- [ ] **T-11.50** Implement economy states: with-data, no-data-for-currency, insufficient-data warning (event count < `economy_ratio_min_events`), client-provenance "best-effort" label when data is client-sourced — *cite:* 11 §3.4 (States); provenance from Foundation §4.5; knob owned by 03; client-provenance per 00.5.

### J. View — Retention (11 §3.5; FR-017)

- [ ] **T-11.51** Build `metrics/retention.njk` + `retention.controller.ts` GET `/panel/:gameId/retention` with the explicit "Classic Day-N Retention" header label — *cite:* 11 §3.5 (Header label); FR-017; research §B-3. Reads `COHORT`/`RETENTION_CELL` (phase 04, Foundation §5).
- [ ] **T-11.52** Add the Retention Curve multi-series line chart (X = day offset 0–30, Y = retention %, one line per recent cohort fading to gray, D0 always 100%, D1/D7/D30 markers labelled) — *cite:* 11 §3.5 (Retention Curve), §4.3 chart-types (`line` multi, D0=100%). (after T-11.30)
- [ ] **T-11.53** Add the Cohort Table (Install Date, Cohort Size, D1, D7, D30, optional D14/D21): immature cells (`today − cohort_date < offset`) render "N/A" muted (never a misleading number), small-cohort warning icon when size < `retention_min_cohort_size`, sortable newest-first, HTMX pagination 30/page — *cite:* 11 §3.5 (Cohort Table); FR-017 (immature masking); knob owned by 04.
- [ ] **T-11.54** Implement retention states: with-data, no-cohorts empty, all-immature (table full of N/A + explanation), small-cohort-warning, loading — *cite:* 11 §3.5 (States).

### K. View — Monetization (11 §3.6; FR-025)

- [ ] **T-11.55** Build `metrics/monetization.njk` + `monetization.controller.ts` GET `/panel/:gameId/monetization` with period selector + dimension selector (Level Bucket / Region / In-Game State / Payer Tier from `monetization_dimensions`, HTMX swap) — *cite:* 11 §3.6 (Period + Dimension selectors); knob owned by 05. Reads `MONETIZATION_CELL`/`PAYER_DAY`/`PURCHASE_IDEMPOTENCY` (phase 05, Foundation §5).
- [ ] **T-11.56** Add the Revenue Over Time stacked bar/area chart segmented by the selected dimension's values, with legend — *cite:* 11 §3.6 (Revenue Over Time), §4.3 chart-types (`bar` stacked). (after T-11.30)
- [ ] **T-11.57** Add monetization summary cards: Total Revenue, Total Sales, ARPPU, Conversion Rate (payers/DAU) with trend arrows — *cite:* 11 §3.6 (Summary cards); ARPPU/conversion are read-time (T-11.26).
- [ ] **T-11.58** Add the Product × Dimension cross table (rows = products by revenue desc, cols = dimension values, cells = revenue, empty = `—`, always-present "Unknown" column for missing-context revenue per FR-021, "% of revenue with full context" coverage badge) — *cite:* 11 §3.6 (Cross Table); Foundation §1.2 (`dim_combo` 'unknown' first-class); era boundaries from T-11.28.
- [ ] **T-11.59** Add the two side panels: "By Region" + "By Payer Tier" horizontal bar charts (Whale/Dolphin/Minnow/Non-payer), available regardless of the main dimension selector — *cite:* 11 §3.6 (Side panels), §4.3 chart-types (`bar` horizontal). (after T-11.30)
- [ ] **T-11.60** Add the FX stale-rate warning banner (when any purchase in period used a stale FX rate per `fx_staleness_max_days`, show affected amount + days-stale) and the `fx_unconverted` parked-purchases note ("N purchases parked — tier indeterminate") — *cite:* 11 §3.6 (FX warning); `EXCEPTION_TALLY` reasons `fx_stale_rate_used`/`fx_unconverted` (Foundation §1.2); knob owned by 05; `has_unconverted_spend` per Foundation §1.2.
- [ ] **T-11.61** Implement monetization states: with-data, no-purchases, all-context-missing, FX warnings, loading — *cite:* 11 §3.6 (States).

### L. View — Sessions (11 §3.7)

- [ ] **T-11.62** Build `metrics/sessions.njk` + `sessions.controller.ts` GET `/panel/:gameId/sessions` — *cite:* 11 §3.7. Reads `SESSION_DAY_RESULT`/`ACTIVE_USER_DAY` (phase 02, Foundation §5).
- [ ] **T-11.63** Add the Session Count dual bar chart (sessions by start day solid + sessions touching that day hatched) — *cite:* 11 §3.7 (Session Count), §4.3 chart-types (`bar` dual); reads `SESSION_DAY_RESULT.{session_count,sessions_touching}`. (after T-11.30)
- [ ] **T-11.64** Add sessions summary cards: Total Sessions, Average Duration, Day-1 Average Duration (duration format "12m 24s" / "2h 15m") — *cite:* 11 §3.7 (Summary cards); reads `duration_sum_ms`.
- [ ] **T-11.65** Add the Duration Distribution histogram (fixed 6 buckets 0–5m…2h+, no gap between bars) — *cite:* 11 §3.7 (Duration Distribution), §4.3 chart-types (`bar` histogram). (after T-11.30)
- [ ] **T-11.66** Add the Daily Active Users line chart with 7-day rolling-average overlay (dotted) — *cite:* 11 §3.7 (DAU chart), §4.3 chart-types (`line` + rolling avg); reads `ACTIVE_USER_DAY` (or HLL count lever, Foundation §9.2). (after T-11.30)

### M. View — Config administration (11 §3.8; FR-027; 10 config-effective-time)

- [ ] **T-11.67** Build `config/index.njk` + `config.controller.ts` GET `/panel/:gameId/config` with accordion knob groups per owning phase (01/02/03/04/05/06/07/00.5/10), each header showing phase name + knob count + chevron (Alpine `x-show`) — *cite:* 11 §3.8 (Knob groups); the full knob inventory is 10 §Config administration.
- [ ] **T-11.68** Render the per-group knob table (Key, Current Value, Default, Effect Timing [Forward-only/Retroactive/Display-only], Last Changed date+operator) with each row click → HTMX GET inline edit form — *cite:* 11 §3.8 (Knob table); effect-timing column from 10 §Config administration table.
- [ ] **T-11.69** Implement `config.service.ts` with the inline edit form (typed input per knob value type: text/toggle/textarea-JSON/select), Alpine client-side validation, effective-time explanation text, "Save" = HTMX PUT → **server-side validation against the knob contract** → write `GAME.config` + `CONFIG_AUDIT` via phase 10 admin API → swap row read-only — *cite:* 11 §3.8 (Inline edit form), §4.1 (Inline form submission); 10 §API (config get/set with contract validation, emits `CONFIG_AUDIT`), §Config-effective-time (forward-only, `effective_from`). Panel does NOT redefine any knob's semantics (10 §6).
- [ ] **T-11.70** Handle infra-secret knobs (`cold_storage_credentials`, `fx_table`, erasure-ledger key): mask current value (`••••••••`), edit form warns "encrypted at rest with the platform master key", rotation-by-replace hint — *cite:* 11 §3.8 (Infra-secret knobs); 10 §Infra-secret storage (envelope-encrypted, master key outside Postgres).
- [ ] **T-11.71** Enforce role at config: `viewer` sees read-only rows; the inline-edit endpoint returns 403 for `viewer` — *cite:* 11 §3.8 (Role enforcement), §7.3; 10 §ER (viewer cannot write config). (after T-11.21)
- [ ] **T-11.72** Build `config/audit.njk` GET `/panel/:gameId/config/audit`: table (Date, Operator, Key, Old, New, Effective From), long values expandable (Alpine), HTMX pagination 50/page, filter by operator, empty state — *cite:* 11 §3.8 (`audit.njk`); reads `CONFIG_AUDIT` (phase 10, Foundation §5 acknowledged entity).

### N. View — Operations (11 §3.9; FR-024, 00.5 erasure/access)

- [ ] **T-11.73** Build `ops/cold-storage.njk` + `ops.controller.ts` GET `/panel/:gameId/ops/cold-storage`: enabled/disabled badge, config display (bucket/retention/compression/schedule), upload-history table (Date/Status/File Size/Uploaded At) derived from `UPLOAD_BOOKKEEPING`, "Upload Now" (disabled if no sealed file pending), pagination 30/page — *cite:* 11 §3.9 (`cold-storage.njk`); FR-024; reads `UPLOAD_BOOKKEEPING` (phase 07, Foundation §5); knobs owned by 07.
- [ ] **T-11.74** Build `ops/exceptions.njk` GET `/panel/:gameId/ops/exceptions`: period selector, summary bar (total + worst day), Date×Reason pivot table over all `EXCEPTION_TALLY` reasons with heat-gradient cells, shown only if `drop_counter_visible` on — *cite:* 11 §3.9 (`exceptions.njk`); reads `EXCEPTION_TALLY` (phase 01); knob owned by 01. Reason vocabulary = Foundation §1.2 `EXCEPTION_TALLY.reason` enum.
- [ ] **T-11.75** Build `ops/erasure.njk` GET `/panel/:gameId/ops/erasure` with two Alpine tabs — *cite:* 11 §3.9 (`erasure.njk`), §4.2 (Tabs).
- [ ] **T-11.76** Erasure Requests tab: form (game pre-filled, User ID, operator-verification checkbox), confirmation modal listing exact effects (spine family + payer spine + purchase idempotency erased; aggregates untouched; raw rewritten if `strict_raw_rewrite` on), "Submit" → HTMX POST enqueues the 00.5 erasure job, request-history table (User ID/Requested/Status/Completed) — *cite:* 11 §3.9 (Erasure Requests tab); 00.5 §Q7 erasure job; Foundation §9.6 (four-tier erasure); knob `strict_raw_rewrite` owned by 00.5.
- [ ] **T-11.77** Access Requests tab (GDPR Art. 15/20): same verified form → HTMX POST enqueues the access job, history table with expiring one-time download link (7-day, Redis-backed token) — *cite:* 11 §3.9 (Access Requests tab); 10 §Right-of-access (DSAR access job); 00.5 §9 access job. (after T-11.75)
- [ ] **T-11.78** Enforce role at ops: `viewer` can view request history but cannot submit new erasure/access requests (server-side 403) — *cite:* 11 §3.9 (Role enforcement), §7.3. (after T-11.21)

### O. View — Operator accounts (11 §3.10; admin-only)

- [ ] **T-11.79** Build `operators/list.njk` + `operators.controller.ts` GET `/panel/operators` (admin-only, viewer → 403): table (Email, Role badge, Status, Last Login, Edit/Disable actions) from `OPERATOR_ACCOUNT` — *cite:* 11 §3.10 (`list.njk`); reads `OPERATOR_ACCOUNT` (phase 10). (after T-11.21)
- [ ] **T-11.80** Build `operators/form.njk` (shared create/edit, `isNew` flag) GET `/panel/operators/new` + `/panel/operators/:operatorId/edit`: Email (unique validation via HTMX blur), Role radio/select, Password (required on create / blank-keeps on edit), MFA toggle + "Reset MFA" (regenerate TOTP → QR → verify, same flow as mfa-setup), submit HTMX POST/PUT via phase 10 admin API — *cite:* 11 §3.10 (`form.njk`); 10 §API + §Account security. (after T-11.79)
- [ ] **T-11.81** Implement operator Disable (not delete): confirm-modal, sets `disabled_at`, row preserved for audit-trail integrity — *cite:* 11 §3.10 (Delete/Disable); 10 §ER (`disabled_at`, never deleted). (after T-11.79)

### P. Interactivity, live polling & cross-cutting (11 §4)

- [ ] **T-11.82** Implement the live-polling contract: counter containers use `hx-get` + `hx-trigger="every Ns"` returning only the counter fragment; intervals 30s (metric cards / live event counts, driven by `panel_live_poll_interval_sec`), 60s (`last_used_at`) — *cite:* 11 §4.1 (Live polling); knob §10.
- [ ] **T-11.83** Implement destructive-action patterns: simple `hx-confirm` for low-risk, Alpine type-to-confirm modals for critical (key revoke "REVOKE", game retire) — *cite:* 11 §4.1 (Destructive actions), §4.2 (Type-to-confirm). (after T-11.15)
- [ ] **T-11.84** Implement Alpine dropdown/tab/accordion/flash patterns as documented (`@click.outside` close, `$refs.form.requestSubmit()` to trigger HTMX, `x-show` panels) — *cite:* 11 §4.2.

### Q. Tests & acceptance (spec.md Independent Tests / SC)

- [ ] **T-11.85** Game-isolation test: two registered games, confirm no panel view (dashboard/economy/retention/monetization/sessions/ops) ever shows the other game's data — *cite:* FR-002/SC-003; verified via `GameAccessGuard` scoping (T-11.22).
- [ ] **T-11.86** Live-vs-historical test: confirm current-day figures read from Redis (marked provisional) and sealed-day figures from Postgres, with post-crash fallback to last-flushed value — *cite:* FR-026; Foundation §3.3; verifies T-11.25.
- [ ] **T-11.87** Retention-labelling test: confirm the "Classic Day-N Retention" label renders and immature cells show N/A (never a low number) — *cite:* FR-017; verifies T-11.51/T-11.53.
- [ ] **T-11.88** Role-enforcement test: `viewer` blocked (403) from config-write, credential management, operator management, erasure/access submit; `admin` allowed — *cite:* 11 §7.3; 10 §Account security; verifies T-11.21.
- [ ] **T-11.89** Single-deploy test: panel comes up as part of `docker-compose up` (no separate front-end app/build server); Tailwind build runs at image build — *cite:* SC-009; 11 §9 (Departures); verifies T-11.1/T-11.6.
- [ ] **T-11.90** FR-025 coverage test: confirm per game the panel presents live event counts, economy sink/source, retention D1/D7/D30, and segmented monetization — *cite:* FR-025; verifies the view inventory (Sections H/I/J/K).

---

## 2. Cross-phase dependencies

Foundation §5 ownership: the panel **WRITES nothing** in the metric model — it is a pure READER of every result structure and a caller of phase-10 / phase-00.5 write APIs. Specifically:

- **From phase 10 (operator admin) — hard prerequisite for the whole auth gate + all writes.** The panel READS `OPERATOR_ACCOUNT` (auth/roles), `GAME_SDK_KEY` / `GAME_SERVER_CREDENTIAL` (credential cards), `CONFIG_AUDIT` (audit view), and WRITES `GAME`/`GAME.config`/credentials/`CONFIG_AUDIT` **only through phase 10's admin API** — it never writes these tables directly (10 §API; Foundation §5: `GAME` owned by 01, admin API is phase 10). T-11.18–T-11.24, T-11.32–T-11.37, T-11.67–T-11.72, T-11.79–T-11.81 all block on phase 10 existing. The four `operator_*` knobs (10 §6) govern the auth behavior; the config-effective-time rule (10) governs T-11.69.
- **From the Foundation §3.3 read model + §2.1 Redis grammar — required before any metric view renders.** The panel READS Postgres result tables (sealed days) and open-day Redis buckets (owned by each domain per Foundation §5, "read by read model") but WRITES none. T-11.25–T-11.28 (the merge service) block on the flusher + open-day bucket conventions being final; every metric view (Sections H–L) blocks on T-11.25.
- **From phases 01–07 (result structures) — read-only, per Foundation §5.** `EVENT_CATALOG`/`EVENT_DAY_COUNT`/`EXCEPTION_TALLY` (01) → overview + exceptions; `SESSION_DAY_RESULT`/`ACTIVE_USER_DAY` (02) → sessions + DAU; `ECONOMY_FLOW_RESULT`/`ECONOMY_SUPPLY_DAY`/`BALANCE_SNAPSHOT` (03) → economy; `COHORT`/`RETENTION_CELL` (04) → retention; `MONETIZATION_CELL`/`PAYER_DAY`/`PURCHASE_IDEMPOTENCY` (05) → monetization; derived KPIs (06) computed at read time; `UPLOAD_BOOKKEEPING` (07) → cold-storage view. Each corresponding view task (T-11.40–T-11.66, T-11.73) cannot render real data until its owning phase writes the structure.
- **From phase 00.5 (ops envelope) — for the ops views.** The erasure job (Q7) and DSAR access job are TRIGGERED by the panel (T-11.76/T-11.77) but OWNED and executed by 00.5/10; the panel only enqueues + shows history. `rate_limited` tally + client-provenance labels also originate in 00.5.
- **Every knob the config view surfaces is owned by its phase (10 §6 rule):** the panel validates/writes via the phase-10 contract but never redefines knob semantics. T-11.67–T-11.71 depend on each phase's `§6` knob contract being defined.

## 3. Acceptance & test mapping

| SC / FR | Requirement | Satisfying task(s) | Verification |
|---|---|---|---|
| **FR-025** | Present per game: live events, economy, retention, segmented monetization | T-11.40–T-11.42 (events), T-11.44–T-11.50 (economy), T-11.51–T-11.54 (retention), T-11.55–T-11.61 (monetization), + T-11.90 test | Panel renders all four surfaces for a game; test T-11.90. Spec Acceptance Scenarios US2/US3/US4 (`spec.md` §55/§73/§81). |
| **FR-026** | Read live from Redis, historical from Postgres | T-11.25 (merge service), T-11.27 (Redis reads), T-11.35/T-11.82 (live polling), + T-11.86 test | Current-day = Redis (provisional), sealed = Postgres, post-crash fallback to last flush (Foundation §3.3). |
| **FR-002 / SC-003** | No dashboard view crosses game boundaries | T-11.22 (`GameAccessGuard`), + T-11.85 test | Two-game isolation test: one game's view never shows another's data (`spec.md` §47/§193). |
| **FR-017** | Classic Day-N retention, explicitly labelled, immature masked | T-11.51 (label), T-11.52 (curve, D0=100%), T-11.53 (cohort table N/A masking), + T-11.87 test | Header reads "Classic Day-N Retention"; immature cells N/A not low numbers (`spec.md` §146). |
| **SC-009** | Whole platform via single `docker-compose up`, panel included | T-11.1 (embedded module), T-11.6 (build-time Tailwind), T-11.8 (CDN/vendor JS), + T-11.89 test | No separate front-end app/build server (11 §9 Departures); one NestJS process (`spec.md` §198). |
| FR-024 (surfaced) | Cold-storage status visible | T-11.73 | `UPLOAD_BOOKKEEPING`-derived status table + config display (11 §3.9). |
| FR-027 (surfaced) | All operational knobs configurable | T-11.67–T-11.71 | Config admin over every phase's `§6` knob with contract validation + audit (10 §Config administration). |
| Auth / role split | Operator auth + admin/viewer enforcement | T-11.18–T-11.24, T-11.21, + T-11.88 test | Login/MFA/lockout/session (11 §7); viewer blocked from writes (10 §Account security). |

## 4. Open considerations / flags for /plan

1. **Session store backend choice (Redis vs Postgres).** 11 §7.1 says "express-session or similar with a Postgres/Redis session store" without pinning one. Redis is already present (queue + hot counters, `noeviction`) — reusing it for sessions is natural but adds session keys to a `noeviction` instance (sessions must self-expire by TTL, never be evicted). Postgres session table is the safer isolation but adds write traffic. **Flag for /plan** — pick one; if Redis, confirm session-key TTL semantics under `noeviction`.
2. **NestJS Nunjucks MVC integration is not a first-class NestJS view engine.** NestJS ships Handlebars/EJS/Pug adapters out of the box; Nunjucks needs a manual `app.engine`/custom render setup. This is an implementation wiring detail (T-11.2) the design assumes works; **flag the exact adapter/render-callback approach for /plan.**
3. **`credential:show` Redis flag under `noeviction` + panel session store.** T-11.37's 5-min show-once flag and T-11.77's 7-day download token both live in Redis. Same `noeviction` caveat as (1): these must expire by TTL and never collide with the queue/counter keyspace — needs a reserved key namespace (e.g. `panel:*`) outside Foundation §2.1's per-game grammar. **Flag key-namespace reservation for /plan** (Foundation §2.1 owns the metric domains; panel operational keys are a new, un-owned namespace).
4. **Read-model merge cost on wide dashboards.** T-11.25/T-11.39 render 8 KPI cards + multiple charts, each potentially fanning out to several Postgres result tables + Redis buckets per request, with read-time ratio/trend computation over two periods (current + preceding). On a busy multi-game instance the overview page could be N queries; **flag for /plan** whether per-request result caching or a batched read-model query is needed (design says "provisional / live poll every 30s", which multiplies the read frequency).
5. **HLL count-lever vs exact membership at read time (Foundation §9.2).** DAU/MAU/stickiness cards (T-11.39, T-11.66) read `ACTIVE_USER_DAY`. If a deployment flips the HLL scale lever, those counts come from a sketch (±error) while retention (T-11.51) must stay on exact spine bitmap. The panel must know which structure backs each read; **flag that the read-model service needs to branch on the lever state** (Foundation §9.2 forbids HLL for retention/membership reads — panel must not accidentally read a sketch where membership is needed).
6. **Chart config serialized into HTML `data-chart-config` attributes.** T-11.29 embeds JSON Chart.js config in DOM attributes; large datasets (90-day multi-cohort retention curves, T-11.52) could produce heavy inline payloads and need HTML-escaping of the JSON. **Flag payload-size + escaping for /plan** (also a mild XSS surface if any label is client-supplied game/event/currency/dimension text — must be escaped, since event names, currencies, and dimensions are client-supplied free-form per Foundation §2.3 observed-value cap).
7. **`operator`-scoped "accessible games" for the game selector (T-11.14).** 11 §2.2 says the selector is "populated from the operator's accessible games", but 11 §7.2 says "all operators with dashboard access can view all games" (no per-game permission model in v1). These are reconcilable (accessible = all games in v1) but the wording differs; **flag that v1 = all games** so the selector is not built against a non-existent per-operator ACL.
8. **`drop_counter_visible` knob (T-11.74) is referenced in 11 §3.9 but not in the 10 §Config administration inventory.** The exceptions view gates on it; confirm the knob exists and its owner (01, alongside the other exception/cap knobs). **Flag a knob-inventory reconciliation for /plan** — either it is an 01 knob the 10 inventory omitted, or the view should gate on an existing 01 knob.
9. **Panel-owned knobs are platform-level but the config view groups by per-game phase (T-11.67).** The four `panel_*` knobs (§10) and the `operator_*` / `reporting_offset` knobs are platform-level, not per-game, yet the config view is reached at `/panel/:gameId/config`. **Flag for /plan** how platform-level knobs surface in a game-scoped config page (likely a separate "Platform" group or a `/panel/config` route) so a platform knob isn't presented as per-game-editable.
