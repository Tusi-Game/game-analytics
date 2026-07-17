# Panel (Operator Dashboard)

**Part of:** [001-analytics-platform](../001-analytics-platform/spec.md)
**Layer:** presentation design · **Status:** Draft (2026-07-17)
**Depends on:** [002-foundation-ingest](../002-foundation-ingest/spec.md), [003-sessions](../003-sessions/spec.md), [004-economy](../004-economy/spec.md), [005-retention](../005-retention/spec.md), [006-monetization](../006-monetization/spec.md), [007-derived-kpis](../007-derived-kpis/spec.md), [008-cold-storage](../008-cold-storage/spec.md), [011-operator-admin](../011-operator-admin/spec.md), and the shared [ops envelope](../001-analytics-platform/ops-envelope.md)

**Grounding**: Foundation §1.2 (`GAME` registry), §3.3 (read model), §4.5 (credential classes), §5 (ownership matrix); every sibling story `§6 Configurations`; [011-operator-admin](../011-operator-admin/spec.md) (operator accounts, credential lifecycle, config-effective-time rule); [ops envelope](../001-analytics-platform/ops-envelope.md) (rate-limit, erasure knobs, scale envelope); [research.md](../001-analytics-platform/research.md) §7 (Q2 key classes, Q7 erasure, Q10 licensing).
**Consumed by**: the entire platform as its human-facing surface.
**Altitude**: presentation-layer design — rendering stack, layout, template hierarchy, view inventory, interactivity model, asset pipeline. **No implementation code, no DDL, no Redis keys, no worker pseudocode.**

> **Note on structure.** The Panel is a single design-heavy document with no clean story/design split. Per the re-homing rule for this story, the story-level intent — the architecture decision (rendering stack, module tree, routing), the full view inventory, session/role requirements, cross-story relationships, departures from the prior spec, and this story's configuration knobs — lives here in `spec.md`. The detailed layout system, interactivity model, asset pipeline, and design system live in [design.md](design.md).

---

## 1. Architecture decision

**The panel is a server-rendered application embedded inside the same NestJS process that runs ingest, workers, and the dashboard API.** No separate front-end app (no Next.js, no Vite, no separate build server). Deploying the platform means deploying one NestJS process with one `docker-compose up`.

**Stack:**

| Layer | Choice | Rationale |
|---|---|---|
| Rendering | Nunjucks (`.njk`) templates, NestJS MVC | Feature-rich templating (blocks, includes, macros), no JSX/build step, one language |
| Styling | Tailwind CSS v4 | Utility-first, compiled once at build time, served as static asset |
| Interactivity | HTMX (~14 KB gzipped) | Partial page updates, live polling, inline form submits — no React |
| Client state | Alpine.js (~15 KB gzipped) | Dropdowns, modals, tabs, toggles — lightweight, no build step, HTML-direct |
| Charts | Chart.js (~60 KB gzipped) | Canvas-based, vanilla JS, CDN-loadable, covers all needed chart types |
| Bundling | None (CDN + compiled CSS) | HTMX, Alpine, Chart.js loaded via CDN `<script>`; Tailwind compiled via PostCSS CLI; custom JS is vanilla, served as-is |

**All assets live inside the NestJS project tree** and are served by `@nestjs/serve-static` (or the built-in `ServeStaticModule`):

```
src/
├── panel/                          # New top-level NestJS module
│   ├── panel.module.ts             # Registers controllers, guards, serve-static
│   ├── auth/
│   │   ├── auth.controller.ts      # GET/POST /panel/login, /panel/logout
│   │   ├── auth.guard.ts           # Session guard for all panel routes
│   │   ├── auth.service.ts         # Password verify, MFA, lockout, session
│   │   └── mfa.controller.ts       # GET/POST /panel/mfa
│   ├── dashboard/
│   │   ├── dashboard.controller.ts # GET /panel/:gameId (dashboard overview)
│   │   └── dashboard.service.ts    # Aggregates live (Redis) + historical (PG)
│   ├── games/
│   │   ├── games.controller.ts     # GET /panel/games, /panel/:gameId/settings, CRUD + key/credential management
│   │   └── games.service.ts        # Game registry, key lifecycle
│   ├── metrics/
│   │   ├── economy.controller.ts   # GET /panel/:gameId/economy
│   │   ├── retention.controller.ts # GET /panel/:gameId/retention
│   │   ├── monetization.controller.ts
│   │   └── sessions.controller.ts
│   ├── config/
│   │   ├── config.controller.ts    # All phase knobs, audit trail
│   │   └── config.service.ts       # Validation against knob contracts, effective-time
│   ├── ops/
│   │   ├── ops.controller.ts       # Cold storage, exceptions, erasure/access
│   │   └── ops.service.ts
│   └── operators/
│       ├── operators.controller.ts # Operator CRUD (admin role only)
│       └── operators.service.ts
├── public/                         # Static assets served at /
│   ├── css/
│   │   └── tailwind.css            # Compiled Tailwind (postcss output)
│   ├── js/
│   │   └── panel.js                # Vanilla JS: Chart.js init, clipboard, helpers
│   └── img/
│       └── logo.svg
└── views/                          # Nunjucks templates (resolved by NestJS MVC)
    ├── layouts/
    │   ├── auth.njk                # Minimal centered-card layout (login, MFA)
    │   └── panel.njk               # Main layout: sidebar + topbar + content area
    ├── partials/
    │   ├── sidebar.njk             # Navigation sidebar with game selector
    │   ├── topbar.njk               # Top bar with breadcrumb + operator menu
    │   ├── game-selector.njk        # HTMX-powered game dropdown
    │   ├── metric-card.njk          # Reusable KPI card (label + value + trend)
    │   ├── chart-fragment.njk       # Canvas + inline Chart.js init (used by chart endpoints)
    │   ├── period-selector.njk      # Time-range dropdown (24h/7d/30d/90d/custom)
    │   ├── empty-state.njk          # "No data yet" placeholder with icon
    │   ├── error-alert.njk          # Dismissible error banner with retry
    │   └── confirm-modal.njk        # Alpine.js confirmation dialog for destructive actions
    ├── auth/
    │   ├── login.njk
    │   └── mfa-setup.njk
    ├── dashboard/
    │   └── index.njk
    ├── games/
    │   ├── list.njk
    │   ├── detail.njk               # Game hub: keys, credentials, quick stats
    │   └── credential-show.njk      # "Show once" server credential display
    ├── metrics/
    │   ├── economy.njk
    │   ├── retention.njk
    │   ├── monetization.njk
    │   └── sessions.njk
    ├── config/
    │   ├── index.njk                # All knobs grouped by owner phase
    │   └── audit.njk                # CONFIG_AUDIT trail viewer
    ├── ops/
    │   ├── cold-storage.njk
    │   ├── exceptions.njk
    │   └── erasure.njk
    └── operators/
        ├── list.njk
        └── form.njk                 # Shared create/edit form
```

**Routing convention:**

- All panel routes under `/panel/*` so the ingest path (`/v1/events`) and panel paths never collide.
- `/panel/:gameId` — Dashboard overview (landing view when a game is selected).
- `/panel/:gameId/settings` — Game detail/hub (SDK keys, credentials, quick stats, retire).
- `/panel/:gameId/economy`, `/panel/:gameId/retention`, etc. — Metric views.
- `/panel/:gameId/config`, `/panel/:gameId/ops/*` — Admin views.
- Non-game routes: `/panel/games` (game list), `/panel/operators` (admin), `/panel/login` (auth).
- All game-scoped routes extract `gameId` via a param decorator; a `GameAccessGuard` loads the `GAME` entity, verifies it exists, and attaches it to the request.
- Metric endpoints support `?period=7d|30d|90d|custom&from=&to=` query params for time-range selection.
- Chart data endpoints (e.g. GET `/panel/:gameId/economy/chart?period=7d`) return just the chart container HTML fragment so HTMX can swap it in without a full page re-render.

> The layout system, interactivity model, asset pipeline, and design system that realize this architecture are specified in [design.md](design.md).

---

## 2. View inventory

### 2.1 Authentication

#### `auth/login.njk`
- **Purpose**: Operator login.
- **Template**: Extends `auth.njk`.
- **Form fields**: `email` (input[type=email]), `password` (input[type=password]).
- **Submit**: HTMX POST to `/panel/login`. On success → redirect to `/panel/games`. On failure → swap form with error message inline.
- **Lockout UX**: After `operator_login_max_attempts` failures, swap the form for a lockout timer message ("Too many attempts. Try again in X min."). Timer counts down client-side (Alpine.js interval).
- **States**: idle, loading (button disabled + spinner), error (red banner), locked-out.

#### `auth/mfa-setup.njk`
- **Purpose**: First-time MFA enrollment when `operator_mfa_required` is on.
- **Template**: Extends `auth.njk`.
- **Flow**:
  1. Show QR code (rendered as data-URI from server-generated TOTP URI) + manual key with copy button.
  2. Verification step: 6-digit code input + "Verify" button (HTMX POST).
  3. On success → redirect to `/panel/games`. On failure → inline error, allow retry.
- **Skip option**: If MFA is optional (`operator_mfa_required = false`), show "Skip for now" link.
- **States**: setup (QR + key shown), verifying (code input), success (redirect), error.

### 2.2 Game management

#### `games/list.njk`
- **Purpose**: Landing page after login. Lists all registered games.
- **Route**: GET `/panel/games`
- **Sections**:
  - Header: "Games" + `[+ Register Game]` button (Alpine.js toggle opens inline form).
  - Search input (filters rows client-side via Alpine.js).
  - Table columns: Name, Daily Events (live from Redis, HTMX-polled badge), Status (Active/Retired), Open link.
  - Empty state when no games: "No games registered yet" with CTA to register.
- **New game form** (inline, Alpine.js `x-show`):
  - Game Name input.
  - "Register" button (HTMX POST, on success → redirect to game detail showing the issued SDK key).
  - "Cancel" button (hides form).
- **States**: list with games, empty (no games), loading skeleton, error loading.

#### `games/detail.njk`
- **Purpose**: Per-game hub — SDK key management, server credentials, quick stats.
- **Route**: GET `/panel/:gameId/settings`
- **Sections**:

  **SDK Key card:**
  - Displays key prefix (e.g. `sk_live_abc123...`) with a copy-to-clipboard button.
  - Metadata: created date, last used timestamp (live polled via HTMX every 60s).
  - "Rotate Key" button → issues a new key, shows it inline. Old key remains active (dual-active rotation window).
  - "Revoke Key" button → triggers `confirm-modal.njk` with explicit warning: "All shipped builds using this key will be unable to send events. This cannot be undone." Requires typing "REVOKE" to confirm. HTMX DELETE on confirm.

  **Server Credentials card:**
  - Table of credentials: prefix, created date, last used, status (active/revoked).
  - "Create Server Credential" button → HTMX POST, response redirects to `credential-show.njk`.
  - Per-credential: "Rotate" (create new, keep old active) and "Revoke" (with confirm-modal).

  **Quick Stats card:**
  - Mini metric cards: DAU, MAU, Events (24h), Total Sessions (24h).
  - Live-polled via HTMX every 30s. Marked "provisional" for current-day figures.
  - Link: "View Full Dashboard →" (navigates to `/panel/:gameId`).

  **Retire Game:**
  - Footer button, distinct visual treatment (red/outline). Confirm-modal: "Retiring stops all ingestion but preserves data. Cold storage continues for existing files." HTMX POST `/panel/:gameId/settings/retire`.

- **States**: active game (all sections), retired game (sections with "Retired" badge, create/rotate/revoke actions disabled, data still visible).

#### `games/credential-show.njk`
- **Purpose**: Display a newly created server credential exactly once.
- **Route**: GET after credential creation (redirected from POST).
- **Template**: Extends `panel.njk`. Content is a warning card.
- **Content**:
  - Warning icon + "This credential is shown ONLY ONCE. Store it securely now."
  - Full credential value with copy button.
  - "I've saved this credential" button → records acknowledgement, redirects back to game detail.
- **No browser back-button bypass**: the GET route checks a short-lived Redis flag (`credential:show:{credential_id}:{operator_id}` with 5-min TTL). If flag is absent, redirects to game detail with a "credential no longer available" flash message. The credential value itself is never stored in a session or rendered again.

### 2.3 Dashboard overview

#### `dashboard/index.njk`
- **Purpose**: Per-game overview with key metrics at a glance.
- **Route**: GET `/panel/:gameId` (the default landing view when a game is selected from the sidebar or game list).
- **Sections**:

  **Period selector** (partial: `period-selector.njk`):
  - Alpine.js dropdown: Last 24h | 7 days | 30 days | 90 days | Custom range.
  - Changing the period triggers HTMX GET to the same URL with `?period=`, swapping all metric cards and charts.

  **KPI cards row** (partial: `metric-card.njk`):
  - Eight cards in a responsive grid (2 cols on mobile, 4 on desktop).
  - Cards: DAU, MAU, Stickiness (DAU/MAU), ARPDAU, Events (24h), Sessions (24h), Revenue (period), ARPPU.
  - Each card: label, large value, trend arrow (↑/↓ + percentage vs previous period), provisional badge if period includes today.
  - Examples:
    ```
    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ DAU      │ │ MAU      │ │Stickiness│ │ARPDAU    │
    │ 1,247    │ │ 8,420    │ │  14.8%   │ │  $0.04   │
    │ ↑ 12%    │ │ ↑ 8%     │ │  ↑ 2%    │ │  ↑ 5%    │
    └──────────┘ └──────────┘ └──────────┘ └──────────┘
    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
    │ Events   │ │ Sessions │ │ Revenue  │ │ ARPPU    │
    │ 45.2K    │ │  3,810   │ │  $342    │ │  $1.83   │
    │          │ │          │ │  ↑ 15%   │ │  ↑ 3%    │
    └──────────┘ └──────────┘ └──────────┘ └──────────┘
    ```
  - Trend arrow logic: compare current period's value against the preceding equal-length period. Render `—` (flat) if < 1% change. Server computes trend in the controller, passes to template.

  **Event Activity chart:**
  - Line chart: daily event count over the selected period.
  - Container is a `<div>` with `hx-get` + `hx-trigger="load"` + skeleton pulse classes. When HTMX fires, the server returns a `<canvas>` via `chart-fragment.njk` + inline `<script>` that initializes Chart.js.

  **Top Events table:**
  - Table: Event Name | Count (period) | % of Total.
  - Rendered server-side with the initial page (no separate HTMX load).
  - Limited to `top_n_events` rows (config knob from [002-foundation-ingest](../002-foundation-ingest/spec.md)).

  **Latest Exceptions card:**
  - Summary of today's `EXCEPTION_TALLY` rows.
  - Format: "Today: 3 rate_limited, 12 nameless, 0 quarantined_typed".
  - Link: "View all exceptions →" (navigates to ops exceptions page).

- **States**: with data, no data (empty-state per section), loading (skeleton pulse on cards + chart containers), error per-section (failed chart loads show error-alert with retry button).

### 2.4 Economy

#### `metrics/economy.njk`
- **Purpose**: Sink/source economy dashboard — net flow, sink ratio, top faucets/drains, per-currency breakdown.
- **Route**: GET `/panel/:gameId/economy`
- **Sections**:

  **Period + Currency selectors:**
  - Period selector (shared partial).
  - Currency dropdown: populated from observed currency IDs (Redis `{game_id}:eco:cur` set). "All Currencies" option aggregates. HTMX swap on change.

  **Net Flow chart:**
  - Line chart with dual area: green area = sources, red area = sinks, dotted black line = net flow.
  - X-axis: dates. Y-axis: amount.
  - Chart bounds: auto-scaled; Y starts at 0 to avoid misleading zoom.

  **Summary cards:**
  - Total Sources, Total Sinks, Net Flow, Sink Ratio.
  - Sink Ratio displayed as percentage (Sinks / Sources × 100). N/A when Sources = 0.

  **Top Faucets / Top Drains** (side-by-side, each a ranked table):
  - Columns: Rank, Reason, Amount, % of Total.
  - Limited to `economy_top_n_reasons` rows (config knob from [004-economy](../004-economy/spec.md)).
  - Color-coded: green for sources, red for sinks.

  **Currency Breakdown:**
  - Horizontal stacked bar or simple progress bars per currency.
  - Format: Currency icon/name, bar (proportional width), percentage.
  - Example: `💰 Gold  ████████████ 68%` · `💎 Gems  ██████ 32%` · `🪙 Coins ██ 5%`

  **Money Supply trend** (when `economy_depth_capture_mode` is on, [004-economy](../004-economy/spec.md) Q5):
  - Dual line chart: measured supply (from `ECONOMY_SUPPLY_DAY`) vs cumulative-flow-implied supply.
  - Divergence = diagnostic signal. Label with cohort: "over N balance-reporting holders."

- **Interactivity**: All sections swap together on period/currency change (single HTMX GET).

- **States**: with data, no data for selected currency, insufficient data (event count < `economy_ratio_min_events` — show warning), client-provenance label (all metrics marked "best-effort" when using client-sourced data per [ops envelope](../001-analytics-platform/ops-envelope.md)).

### 2.5 Retention

#### `metrics/retention.njk`
- **Purpose**: Classic Day-N retention curves and cohort table.
- **Route**: GET `/panel/:gameId/retention`
- **Sections**:

  **Header label:**
  - Explicit label: "Classic Day-N Retention" (per FR-017, §B-3 in [research.md](../001-analytics-platform/research.md)).

  **Retention Curve chart:**
  - Multi-series line chart. X-axis: Day offset (0–30). Y-axis: Retention % (0–100).
  - One line per recent cohort (last N cohorts), each in a distinct color fading toward gray for older cohorts.
  - Alternatively: single line showing average D0–D30 across all mature cohorts, with min/max bands.
  - D0 always 100% (definitional invariant).
  - Key data points labelled: D1 marker, D7 marker, D30 marker with values.

  **Cohort Table:**
  - Columns: Install Date, Cohort Size, D1, D7, D30, D14 (optional), D21 (optional).
  - Immature cohorts: cells where `today − cohort_date < offset` render "N/A" with a muted style. Never a misleading number.
  - Small-cohort warning: rows where cohort size < `retention_min_cohort_size` display a warning icon with tooltip: "Small cohort — interpret with caution."
  - Sortable by cohort date (default: newest first).
  - Pagination: 30 cohorts per page (HTMX "Load more" or paginated links).

- **Interactivity**: Cohort table pagination via HTMX (append rows or replace page). Chart reloads on period change.
- **States**: with data, no cohorts (empty state), all immature (show table with N/A cells + explanation), small-cohort warning, loading.

### 2.6 Monetization

#### `metrics/monetization.njk`
- **Purpose**: Segmented monetization analytics — revenue by product × dimension × period.
- **Route**: GET `/panel/:gameId/monetization`
- **Sections**:

  **Period + Dimension selectors:**
  - Period selector (shared).
  - Dimension selector dropdown: Level Bucket, Region, In-Game State, Payer Tier (from `monetization_dimensions` config). HTMX swap on change.

  **Revenue Over Time chart:**
  - Stacked bar or stacked area chart. Bars segmented by the selected dimension's values.
  - X-axis: dates. Y-axis: revenue (normalized).
  - Legend: dimension values with colors.

  **Summary cards:**
  - Total Revenue, Total Sales, ARPPU, Conversion Rate (payers / DAU).
  - All for the selected period with trend arrows.

  **Product × Dimension Cross Table:**
  - Rows: products (packages), sorted by revenue descending.
  - Columns: dimension values (dynamic, from the selected dimension).
  - Cells: revenue. Empty cells = `—`.
  - "Unknown" column: revenue with missing context (when companion event never arrived per FR-021). Always present, even if zero, to make coverage visible.
  - Context coverage badge: "% of revenue with full context" — signals companion-delivery health.

  **Side panels (two-column on desktop, stacked on mobile):**
  - Left: "By Region" — horizontal bar chart, revenue per region.
  - Right: "By Payer Tier" — horizontal bar chart, revenue per tier (Whale/Dolphin/Minnow/Non-payer).
  - These are the two most requested slice dimensions; available regardless of the main dimension selector.

  **FX stale-rate warning:**
  - Banner when any purchase in the period used a stale FX rate (controlled by `fx_staleness_max_days` knob). Shows affected amount and days-stale.
  - `fx_unconverted` purchases noted separately: "N purchases ($X) parked — tier reads indeterminate."

- **Interactivity**: Dimension change swaps charts + table. Period change swaps all.
- **States**: with data, no purchases in period, all-context-missing (show "Unknown" column full), FX warnings, loading.

### 2.7 Sessions

#### `metrics/sessions.njk`
- **Purpose**: Session engagement analytics — counts, durations, daily active users.
- **Route**: GET `/panel/:gameId/sessions`
- **Sections**:

  **Session Count chart:**
  - Bar chart: sessions per day over the selected period.
  - Dual bar: sessions by start day (solid) + sessions touching that day (hatched overlay).

  **Summary cards:**
  - Total Sessions, Average Duration, Day-1 Average Duration.
  - Duration format: "12m 24s" for sub-hour, "2h 15m" for longer.

  **Duration Distribution:**
  - Histogram (bar chart): session count by duration bucket.
  - Buckets: 0–5m, 5–15m, 15–30m, 30m–1h, 1h–2h, 2h+.
  - X-axis: buckets. Y-axis: count.

  **Daily Active Users chart:**
  - Line chart: DAU over the selected period.
  - Overlay: 7-day rolling average (dotted line).

- **States**: with data, no sessions in period, loading.

### 2.8 Config administration

#### `config/index.njk`
- **Purpose**: View and edit all per-game configuration knobs.
- **Route**: GET `/panel/:gameId/config`
- **Sections**:

  **Knob groups** (accordion, Alpine.js `x-show`):
  - Each section corresponds to a knob-owning story ([002-foundation-ingest](../002-foundation-ingest/spec.md) Ingest, [003-sessions](../003-sessions/spec.md), [004-economy](../004-economy/spec.md), [005-retention](../005-retention/spec.md), [006-monetization](../006-monetization/spec.md), [007-derived-kpis](../007-derived-kpis/spec.md) Derived KPIs, [008-cold-storage](../008-cold-storage/spec.md) Cold Storage, [ops envelope](../001-analytics-platform/ops-envelope.md), [011-operator-admin](../011-operator-admin/spec.md) Admin).
  - Group header: phase name, knob count, expand/collapse chevron.
  - Expanded: table of knobs.

  **Knob table per group:**
  - Columns: Key, Current Value, Default, Effect Timing (Forward-only / Retroactive / Display-only), Last Changed (date + operator).
  - Each row is clickable → opens `config/edit.njk` inline (HTMX GET the edit form, swap it below the row).

  **Inline edit form** (HTMX-loaded, per knob):
  - Knob key (read-only label), description (from the owning story's §6).
  - Input field typed to the knob's value type: text input (string/number), toggle (boolean), textarea (JSON), select (enumerated values).
  - Client-side validation via Alpine.js (e.g., number range, regex for time values).
  - "Effective time" explanation: text explaining when the change takes effect (immediate → next worker cache refresh, or next session, or forward-only with era boundary).
  - "Save" button (HTMX PUT) → validates server-side against knob contract, writes `GAME.config` + `CONFIG_AUDIT`, swaps row back to read-only with updated value.
  - "Cancel" button → removes inline form, restores row.

  **Infra-secret knobs:**
  - Sensitive knobs (`cold_storage_credentials`, `fx_table`, erasure-ledger key): current value masked (`••••••••`), edit form warns "This secret is encrypted at rest with the platform master key."
  - Rotation hint: "To rotate, replace with the new value."

- **Role enforcement**: `viewer` role operators see all knobs as read-only — the click-to-edit behavior is disabled server-side (the inline form endpoint returns 403).

- **States**: admin (editable rows), viewer (read-only), loading, knob validation error (inline red message below input).

#### `config/audit.njk`
- **Purpose**: View the `CONFIG_AUDIT` trail for a game.
- **Route**: GET `/panel/:gameId/config/audit`
- **Sections**:
  - Table: Date, Operator, Key, Old Value, New Value, Effective From.
  - Old/New values truncated for long values; expandable on click (Alpine.js).
  - Pagination: 50 rows per page, HTMX paginated.
  - Filter: by operator (if multiple operators exist).
  - Empty state: "No config changes yet."

### 2.9 Operations

#### `ops/cold-storage.njk`
- **Purpose**: Cold storage lifecycle status.
- **Route**: GET `/panel/:gameId/ops/cold-storage`
- **Sections**:
  - Status summary: Cold storage enabled/disabled badge.
  - Configuration display: bucket, retention days, compression, upload schedule.
  - Upload history table: Date, Status (pending/uploaded/local-deleted/failed), File Size, Uploaded At.
  - Pagination: 30 days per page.
  - Status derived from `UPLOAD_BOOKKEEPING` at read time per [008-cold-storage](../008-cold-storage/spec.md).
  - "Upload Now" button (triggers immediate upload job) — disabled if no sealed file pending.
- **States**: enabled, disabled ("Cold storage is off. Enable it in config."), partial failures (failed rows with retry badge).

#### `ops/exceptions.njk`
- **Purpose**: View `EXCEPTION_TALLY` across all reasons.
- **Route**: GET `/panel/:gameId/ops/exceptions`
- **Sections**:
  - Period selector.
  - Summary bar: total exceptions in period, worst day.
  - Table: Date × Reason pivot. Rows = dates, columns = exception reasons (nameless, unparseable, capexceeded, quarantined_typed, sealed_late, time_fallback, negative_offset, no_spine_row, unknown_kind, fx_stale_rate_used, fx_unconverted, rate_limited).
  - Color-coded cells: gradient from light yellow (few) to red (many).
  - Only shown if `drop_counter_visible` config is on ([002-foundation-ingest](../002-foundation-ingest/spec.md) knob).
- **States**: with exceptions, no exceptions ("All clear — no exceptions in this period."), loading.

#### `ops/erasure.njk`
- **Purpose**: GDPR/CCPA data erasure and access requests.
- **Route**: GET `/panel/:gameId/ops/erasure`
- **Sections** (two tabs, Alpine.js):

  **Erasure Requests tab:**
  - Form: Game selector (pre-filled), User ID input, operator verification checkbox ("I have verified this user's identity").
  - "Submit Erasure Request" button → HTMX POST enqueues the erasure job ([ops envelope](../001-analytics-platform/ops-envelope.md)).
  - Request history table: User ID, Requested At, Status (pending/processing/completed/failed), Completed At.
  - Confirmation modal before submission: lists what will happen — "User spine, payer spine, purchase idempotency records will be irreversibly erased. Aggregate metrics are not affected. Raw files will be rewritten to exclude this user's events on the next upload cycle (if `strict_raw_rewrite` is on)."

  **Access Requests tab (GDPR Art. 15/20):**
  - Form: same as erasure (Game + User ID + verification).
  - "Submit Access Request" button → HTMX POST enqueues the access job ([011-operator-admin](../011-operator-admin/spec.md)).
  - Request history table: User ID, Requested At, Status, Download link (when completed).
  - Download link: expires after 7 days, one-time use (Redis-backed token).

- **Role enforcement**: `viewer` can view request history but cannot submit new requests.
- **States**: forms, request history, processing, completed, error.

### 2.10 Operator accounts

#### `operators/list.njk`
- **Purpose**: Manage operator accounts (admin only).
- **Route**: GET `/panel/operators`
- **Role**: `admin` role only. `viewer` receives 403.
- **Sections**:
  - Header: "Operator Accounts" + `[+ Add Operator]` button.
  - Table: Email, Role badge (Admin/Viewer), Status (Active/Disabled), Last Login, Actions (Edit, Disable).
  - Table populated from `OPERATOR_ACCOUNT` table.
- **States**: list, empty (one operator — yourself).

#### `operators/form.njk`
- **Purpose**: Create or edit an operator account.
- **Route**: GET `/panel/operators/new` or GET `/panel/operators/:operatorId/edit`
- **Shared template** with mode flag (`isNew`).
- **Fields**:
  - Email (required, unique validation via HTMX blur event).
  - Role: Admin / Viewer radio or select.
  - Password (create mode: required; edit mode: "Leave blank to keep current").
  - MFA toggle: "Require MFA" checkbox (edit mode: "Reset MFA" button that generates a new TOTP secret, shows QR code, requires verification — same flow as `mfa-setup.njk`).
- **Submit**: HTMX POST/PUT. On success → redirect to operators list with flash message. On validation error → inline errors.
- **Delete/Disable**: Confirm-modal. Disabling preserves the account row (`disabled_at` set); records are never deleted to maintain audit trail integrity.

---

## 3. Session management

### 3.1 Operator session

- Session stored server-side (express-session or similar with a Postgres/Redis session store).
- Session cookie: `HttpOnly`, `Secure` (when TLS is on), `SameSite=Lax`.
- Session timeout: `operator_session_timeout_min` (default 120 min). On activity, session TTL is refreshed. On timeout, next HTMX request returns a 401 → client redirects to `/panel/login`.
- Login persists a `operator_id` in session. A NestJS guard (`AuthGuard`) reads it, loads the `OPERATOR_ACCOUNT` row, attaches it to `req.operator`, and enforces role checks.

### 3.2 Game access

- All game-scoped routes (`/panel/:gameId/...`) use a `GameAccessGuard` that:
  1. Extracts `gameId` from params.
  2. Loads `GAME` from Postgres.
  3. Attaches to `req.game`.
  4. If not found → 404.
- No separate game-level permission model in v1 (all operators with dashboard access can view all games, per the single-tenant studio model).

### 3.3 Role enforcement

Role checking uses a NestJS decorator that marks routes as `admin`-only. The `AuthGuard` reads the operator's role from the loaded `OPERATOR_ACCOUNT` row and rejects `viewer` operators with 403 and a flash message: "Admin access required." Viewers can read all data and view all pages; they cannot write config, manage credentials, manage operators, or submit erasure/access requests.

---

## 4. Relationship to other stories

- **Consumes from [002-foundation-ingest](../002-foundation-ingest/spec.md)**: `EVENT_CATALOG`, `EVENT_DAY_COUNT`, `EXCEPTION_TALLY` — live counters + exception display.
- **Consumes from [003-sessions](../003-sessions/spec.md)**: `SESSION_DAY_RESULT`, `ACTIVE_USER_DAY` — session counts, DAU, duration distributions.
- **Consumes from [004-economy](../004-economy/spec.md)**: `ECONOMY_FLOW_RESULT`, `BALANCE_SNAPSHOT`, `ECONOMY_SUPPLY_DAY` — economy charts + money supply.
- **Consumes from [005-retention](../005-retention/spec.md)**: `COHORT`, `RETENTION_CELL` — retention curves + cohort table.
- **Consumes from [006-monetization](../006-monetization/spec.md)**: `MONETIZATION_CELL`, `PAYER_DAY`, `PURCHASE_IDEMPOTENCY` — monetization charts + cross-tables.
- **Consumes from [007-derived-kpis](../007-derived-kpis/spec.md)**: Derived KPIs (DAU/MAU/stickiness/ARPU/etc.) computed at read time from the source tables above.
- **Consumes from [008-cold-storage](../008-cold-storage/spec.md)**: `UPLOAD_BOOKKEEPING` — cold-storage status display.
- **Consumes from [011-operator-admin](../011-operator-admin/spec.md)**: `OPERATOR_ACCOUNT`, `GAME_SDK_KEY`, `GAME_SERVER_CREDENTIAL`, `CONFIG_AUDIT` — auth, game/credential management, config audit.
- **Consumes from [ops envelope](../001-analytics-platform/ops-envelope.md)**: Erasure/access jobs, rate-limit tallies, scale envelope.
- **Read model**: Follows Foundation §3.3 — sealed days from Postgres, open days live from Redis with last-flush fallback, today marked provisional.

---

## 5. Departures from prior spec

This story supersedes the following design choices from an earlier revision of the spec:

| Prior decision | New decision | Rationale |
|---|---|---|
| Next.js dashboard as separate app | Server-rendered HTML inside NestJS | Single deployable, no separate build pipeline, one `docker-compose up` |
| Frontend in separate repo or workspace | Same NestJS process | Matches SC-009 (single docker-compose up). No cross-origin fetch complexity |
| ShadCN / React components | Tailwind-only with Nunjucks templates | No React build step. Tailwind utility classes cover all UI needs |
| Client-side routing (Next.js pages) | HTMX-based navigation with server-rendered pages | Simpler. No JS framework. Works without a build step. `hx-push-url` handles browser history |
| Separate frontend build pipeline | Tailwind PostCSS build step only | One CSS file emitted. All JS via CDN. No bundler config |

---

## 6. Configurations

This story's own knobs:

| Knob | Default | Description |
|---|---|---|
| `panel_live_poll_interval_sec` | 30 | Interval for HTMX live counter polling |
| `panel_chart_color_primary` | `#4f46e5` (indigo-600) | Primary chart color (override for white-label) |
| `panel_logo_url` | `/assets/img/logo.svg` | Custom logo path (white-label) |
| `panel_title` | `Game Analytics` | Browser tab title + login page branding |

All four are platform-level (not per-game). The [011-operator-admin](../011-operator-admin/spec.md) knobs (`operator_session_timeout_min`, `operator_login_max_attempts`, `operator_lockout_min`, `operator_mfa_required`) govern the auth behavior this panel implements.
