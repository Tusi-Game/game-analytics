# Panel (Operator Dashboard) — Design

**Story:** [Panel (Operator Dashboard)](spec.md)
**Realizes:** the shared platform base — [foundation.md](../001-analytics-platform/foundation.md) (§1.2 `GAME` registry, §3.3 read model, §4.5 credential classes, §5 ownership matrix)
**Status:** Draft (2026-07-17)

> **Note on structure.** The Panel is a single design-heavy document with no clean story/design split. Per the re-homing rule for this story, the story-level intent — architecture decision, view inventory, session/role requirements, cross-story relationships, departures, and configuration knobs — lives in [spec.md](spec.md). This document carries the detailed **layout system**, **interactivity model**, **asset pipeline**, and **design system** that realize the panel. The rendering stack, module tree, and routing convention that these sections build on are specified in [spec.md §1](spec.md#1-architecture-decision).

---

## 1. Layout system

### 1.1 `auth.njk` — login/MFA layout

Minimal centered card on a dark background. No sidebar, no top bar.

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│                                                          │
│                   [Logo]                                 │
│               Game Analytics                             │
│                                                          │
│          ┌─────────────────────────────┐                 │
│          │                             │                 │
│          │   Email                      │                 │
│          │   [_____________________]    │                 │
│          │                              │                 │
│          │   Password                   │                 │
│          │   [_____________________]    │                 │
│          │                              │                 │
│          │   [       Sign In       ]    │   ← HTMX POST  │
│          │                              │                 │
│          │   Too many attempts.         │   ← conditional │
│          │   Try again in 12 min.       │                 │
│          │                              │                 │
│          └─────────────────────────────┘                 │
│                                                          │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 1.2 `panel.njk` — main layout

Fixed sidebar (collapsible on smaller screens), sticky top bar, scrollable content area.

```
┌──────────────────────────────────────────────────────────────────┐
│  [☰]  [Game: MyGame ▼]                    [Operator: admin@ ▼]  │ ← Top bar
├────────────┬─────────────────────────────────────────────────────┤
│            │                                                     │
│  Dashboard │   ┌─ Content Area ────────────────────────────────┐ │
│  Economy   │   │                                               │ │
│  Retention │   │   All page content renders here.              │ │
│  Monetiz.  │   │   HTMX swaps this region on navigation.       │ │
│  Sessions  │   │                                               │ │
│  ───────── │   │   Lazy-load charts via HTMX hx-get on         │ │
│  Settings  │   │   page load (avoids blocking render).         │ │
│  Config    │   │                                               │ │
│  Ops       │   │                                               │ │
│  Accounts  │   │                                               │ │
│            │   └───────────────────────────────────────────────┘ │
│            │                                                     │
│            │   Footer: version, docs link, build hash            │
│            │                                                     │
└────────────┴─────────────────────────────────────────────────────┘
```

**Sidebar behavior:**
- Game-scoped routes show the game name as a sticky header above nav items.
- Current section highlighted with an active state (Tailwind `bg-indigo-50 text-indigo-700 border-l-2 border-indigo-600`).
- "Accounts" section visible only to `admin` role operators (enforced server-side).
- If no game is selected (on `/panel/games`), sidebar shows "Games" as active and hides game-scoped nav items.

**Top bar (partial: `topbar.njk`):**
- Left: hamburger (mobile sidebar toggle, Alpine.js) + breadcrumb (e.g. "MyGame > Economy").
- Right: game selector dropdown (HTMX GET swaps the entire page to the selected game's dashboard) + operator dropdown (account settings, logout).
- Game selector populated from the operator's accessible games, with a search input for many-game setups.

**Content area:**
- Each page is a Nunjucks template that extends `panel.njk` and fills a `content` block.
- HTMX navigation: sidebar links use `hx-get` + `hx-target="#content"` + `hx-push-url="true"` for SPA-like navigation with working browser history.
- Full page loads (first visit, manual refresh) render the complete layout server-side.

---

## 2. Interactivity model

### 2.1 HTMX usage patterns

**Navigation (SPA-like):** Sidebar links carry `hx-get` targeting the `#content` element with `hx-push-url="true"`. First visit renders the full page server-side; subsequent clicks swap only the content area. Browser history works via `hx-push-url`, which updates the address bar without a full reload.

**Live polling (counters):** Counter containers use `hx-get` with `hx-trigger="every Ns"`. The server returns only the counter HTML fragment, never the full page. Polling intervals: 30s for metric cards and live event counts, 60s for key `last_used_at` timestamps, disabled for static content.

**Lazy chart loading:** Chart containers render with skeleton pulse placeholder classes on first load. A `hx-get` with `hx-trigger="load"` fires after DOM insert, fetching the chart HTML fragment from a dedicated chart endpoint. The returned fragment includes a `<canvas>` element with `data-chart-config` attribute containing serialized Chart.js config, and an inline `<script>` that calls `new Chart(canvas, config)`. A global listener on `htmx:afterSwap` re-initializes all `canvas[data-chart-config]` elements in newly swapped content.

**Inline form submission:** Config knob edit forms use `hx-post` or `hx-put` targeting the closest table row with swap of `outerHTML`. On success, the server returns the updated read-only table row, replacing the edit form. On validation error, the server returns the form with error messages, keeping it open for correction.

**Destructive actions:** Simple confirms use HTMX's built-in `hx-confirm` attribute (browser `confirm()` dialog). Critical actions (SDK key revoke, game retirement) use Alpine.js-powered custom confirmation modals with type-to-confirm pattern (user must type a specific word before the action button enables).

### 2.2 Alpine.js usage patterns

**Dropdowns:** Period selectors and game selectors use `x-data="{ open: false }"` with `@click` to toggle and `@click.outside` to close. Selecting an option sets a hidden form field value and submits the form programmatically via `$refs.form.requestSubmit()`, which triggers the associated HTMX request.

**Tabs:** Multi-panel views (erasure/access requests) use `x-data="{ tab: '...' }"` with `x-show` to toggle content panels and `:class` bindings to style the active tab indicator.

**Type-to-confirm:** For critical destructive actions, a text input uses `x-model` to bind user input to a local variable, and the confirm button uses `:disabled` to stay disabled until the input matches a predefined confirmation string (e.g. "REVOKE").

**Accordion:** Config knob groups use `x-data="{ expanded: false }"` with `x-show` to expand/collapse sections. Each group toggles independently.

**Flash message dismiss:** Flash banners use `x-show` with `x-init="setTimeout(() => show = false, 5000)"` for auto-dismiss after 5 seconds.

### 2.3 Chart.js integration

**Initialization pattern:** A vanilla JS file loaded on every page listens for two events:
- `DOMContentLoaded` — initializes any `canvas[data-chart-config]` elements already in the DOM (for full page loads).
- `htmx:afterSwap` — initializes any new `canvas[data-chart-config]` in swapped content (for HTMX partial updates).

Each canvas carries a `data-chart-config` attribute with a JSON-stringified Chart.js configuration object. The initialization code parses this JSON and passes it directly to `new Chart(canvas, config)`.

**Server-side chart endpoints:** Each metric controller exposes a `GET /chart` sub-route that queries the relevant service for chart data, builds a Chart.js config object, and renders a shared `chart-fragment.njk` partial. The partial emits a `<canvas>` with the serialized config and a unique ID, wrapped in a container with a fixed height class. The controller returns only this fragment — HTMX swaps it into the skeleton placeholder.

**Chart types by metric:**
| Metric | Chart.js type | Configuration |
|---|---|---|
| Event activity | `line` | Smooth (`tension: 0.3`), point dots on data points |
| Net flow (economy) | `line` (dual) | Two datasets (source, sink) with `fill: true`, third dataset (net) as dotted line |
| Top faucets/drains | `bar` (horizontal) | Single dataset, sorted descending |
| Currency breakdown | `bar` (horizontal, stacked) | One bar per currency, width proportional |
| Money supply | `line` (dual) | Two datasets: measured vs cumulative-flow-implied |
| Retention curve | `line` (multi) | One dataset per cohort, D0 always 100%, annotated D1/D7/D30 markers |
| Revenue over time | `bar` (stacked) | One stack per day, segments by dimension value |
| Payer tier / Region | `bar` (horizontal) | Single dataset, sorted descending |
| Session count | `bar` | Dual bar: start-day + touching-day |
| Duration dist. | `bar` (histogram) | Fixed 6 buckets, no gap between bars |
| DAU trend | `line` | Single dataset + 7-day rolling average |

**Chart design system:**
- Colors: Tailwind palette — indigo (primary), emerald (positive/source), red (negative/sink), amber (warnings).
- Font: Inherit from body (`Chart.defaults.font.family` set to system-ui stack).
- Grid lines: Subtle (very light gray, near-invisible).
- Tooltips: Custom HTML renderer for rich tooltips (product name, dimension label, exact value).
- Responsive: `responsive: true, maintainAspectRatio: false` — chart container sets explicit height via CSS class.

---

## 3. Asset pipeline

### 3.1 Tailwind CSS

**Build step** runs once at `docker-compose build` or `npm run build`, using the Tailwind CLI to scan Nunjucks templates and compile only the used utility classes into a single minified CSS file at `src/public/css/tailwind.css`.

**Input CSS** uses `@import "tailwindcss"` with `@source` directives pointing at the `views/` and `public/js/` directories so Tailwind's content scanner finds every class used in templates and JS.

**CSS served** by NestJS `ServeStaticModule`, mounted so that templates reference it as `/assets/css/tailwind.css`.

### 3.2 JavaScript libraries

Three libraries loaded via CDN `<script defer>` tags in the layout's `<head>`: HTMX, Alpine.js, and Chart.js. The project's own vanilla JS (`panel.js`) is served from the static assets directory. No bundler, no `node_modules` bloat for the frontend. Versions are pinned. For air-gapped or sanctions-impacted deployments, the operator vendors these three `.js` files to a local path — the layout needs only a path change.

### 3.3 Icons

No icon library dependency. A small set of inline SVGs lives in a Nunjucks macro file (`views/partials/icons.njk`). Each icon is a macro that accepts name and optional CSS class:

- **Sidebar**: chevron-down, chevron-right, grid (dashboard), chart-bar (economy), users (retention), dollar (monetization), clock (sessions), sliders (config), server (ops), shield (accounts).
- **Actions**: plus, copy, edit, trash, refresh, download, external-link.
- **Status**: check-circle, x-circle, alert-triangle, info.

This avoids an icon-library JS payload and works under sanctions without CDN access for an icon font.

---

## 4. Design system

### 4.1 Tailwind configuration

**Color palette:**
- Primary: `indigo` (actions, active states, chart primary)
- Success: `emerald` (sources, positive trends, active status)
- Danger: `red` (sinks, negative trends, destructive actions, revoked status)
- Warning: `amber` (stale data, small cohorts, provisional markers)
- Neutral: `slate` (text, borders, backgrounds)

**Spacing:**
- Content max-width: `max-w-7xl` (1280px), centered.
- Sidebar width: `w-64` (256px), collapsible to `w-16` on mobile via Alpine.js.
- Metric cards: `p-6` with `rounded-xl` + `shadow-sm` + `border`.

**Typography:**
- Metric card values: `text-3xl font-bold tracking-tight`.
- Metric card labels: `text-sm font-medium text-gray-500 uppercase tracking-wider`.
- Page titles: `text-2xl font-semibold text-gray-900`.
- Table headers: `text-xs font-medium text-gray-500 uppercase tracking-wider`.

**Components (Tailwind utility patterns, not JS components):**
| Component | Classes |
|---|---|
| Primary button | `bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50` |
| Secondary button | `bg-white text-gray-700 border border-gray-300 px-4 py-2 rounded-lg font-medium hover:bg-gray-50` |
| Danger button | `bg-red-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-red-700` |
| Card | `bg-white rounded-xl shadow-sm border border-gray-200 p-6` |
| Badge (active) | `bg-emerald-100 text-emerald-800 text-xs font-medium px-2.5 py-0.5 rounded-full` |
| Badge (retired) | `bg-gray-100 text-gray-600 text-xs font-medium px-2.5 py-0.5 rounded-full` |
| Badge (provisional) | `bg-amber-100 text-amber-800 text-xs font-medium px-2 py-0.5 rounded` |
| Table row | `border-b border-gray-100 hover:bg-gray-50 transition-colors` |
| Table cell | `px-4 py-3 text-sm text-gray-700` |
| Input | `w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500` |
| Skeleton loader | `animate-pulse bg-gray-200 rounded` |

### 4.2 Flash messages

Server sets flash messages via session. Template renders them as dismissible banners (Alpine.js `x-show` + auto-dismiss after 5s):
- Success: green banner with check icon.
- Error: red banner with x icon.
- Warning: amber banner with alert icon.
- Info: blue banner with info icon.

### 4.3 Empty states

Consistent `empty-state.njk` partial:
- Icon (relevant to the section — chart icon for metrics, key icon for credentials, etc.).
- Title: "No data yet" / "No games registered" / "No exceptions".
- Description: contextual explanation of what would appear here.
- CTA button (optional): "Send your first event" / "Register a game" / "Configure dimensions".

### 4.4 Error states

Consistent `error-alert.njk` partial:
- Error icon + message.
- Retry button (triggers `hx-get` on the parent container).
- Dismiss button (Alpine.js `x-show` toggle).
