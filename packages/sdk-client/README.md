# @&lt;org&gt;/analytics-sdk

> **`<org>` is operator input** — the npm organization scope is not yet chosen. Every
> `@<org>/` in this repo is a placeholder resolved before the first `npm publish`
> (it binds the OIDC trusted-publishing config + provenance attestation). During
> development the package is named `@analytics-platform/analytics-sdk`. The **wire**
> identifier `sdk.name = "analytics-sdk"` is stable regardless of the npm scope.

The browser / game **client** analytics SDK for the self-hostable analytics
platform (spec [009-client-sdk]). It turns game-code calls into canonical
envelopes, survives flaky networks and killed tabs, and implements the platform
session definition — the shipped half of the "live counts in minutes" promise.

- **Trust posture.** This SDK is the public, embeddable, *spoofable* path. It
  authenticates with a public `sdk_key` (`pk_…`); every event is server-stamped
  `provenance = client`. It can never mint revenue — money is the server SDK's
  job ([@&lt;org&gt;/analytics-sdk-server]).
- **Zero runtime dependencies.** ESM + CJS + a browser-global bundle + `.d.ts`.

## Install

```bash
npm install @<org>/analytics-sdk
```

## Quickstart (the US1 promise: live counts in minutes)

```ts
import { AnalyticsClient } from '@<org>/analytics-sdk';

const sdk = await AnalyticsClient.init({
  sdkKey: 'pk_live_xxx',                 // PUBLIC key — safe to ship in a build
  endpoint: 'https://analytics.example.com',
});

await sdk.track('level_start', { level: 1 });
```

Script tag / Phaser embed:

```html
<script src="https://unpkg.com/@<org>/analytics-sdk/dist/index.global.js"></script>
<script>
  AnalyticsSDK.AnalyticsClient.init({ sdkKey: 'pk_...', endpoint: '...' })
    .then((sdk) => sdk.track('level_start'));
</script>
```

## API

| Call | Effect |
|---|---|
| `AnalyticsClient.init({ sdkKey, endpoint, ...config })` | Fails fast if `sdkKey` is not a `pk_` key; loads state, reconciles a killed session, starts the flush loop + lifecycle listeners. |
| `track(name, props?)` | One `generic` event; bumps session activity. |
| `economy(flowType, currencyType, amount, reason, context?)` | One client-provenance `economy` flow (`amount > 0`, magnitude only). |
| `newPurchaseAttempt()` | Mints + returns a `purchase_attempt_id` (see below). |
| `purchaseContext(purchaseAttemptId, context?)` | The **zero-money** purchase companion, keyed by `purchase_attempt_id`. |
| `identify(userId)` | Persists `user_id`; emits a one-off `identify` alias edge on the first anon→user transition. |
| `appClose()` | Explicit close for runtimes without reliable lifecycle events. |
| `flush()` | Forces an immediate transmit attempt. |

## Purchases: thread `purchase_attempt_id` through the store call

The client never sends money. To join client-side purchase **context**
(`in_game_state`, player level, session counter) to the authoritative revenue
row emitted by the server SDK, mint a `purchase_attempt_id` and thread it through
both the store purchase **and** the companion:

```ts
const attemptId = sdk.newPurchaseAttempt();

// Thread it into the store purchase so your backend can read it back:
//   StoreKit 2 → Product.PurchaseOption.appAccountToken(UUID(uuidString: attemptId))
//   Google Play → setObfuscatedAccountId(attemptId)
await store.buy(product, { appAccountToken: attemptId });

// Emit the zero-money companion in the SAME session:
await sdk.purchaseContext(attemptId, { player_level: 12, in_game_state: 'boss_fight' });
```

Your backend then relays the SAME `purchase_attempt_id` onto the verified revenue
row via [@&lt;org&gt;/analytics-sdk-server]'s `verifiedPurchase`. **If you cannot thread
it, the companion still ships and the purchase still counts — only the segmented
dimensions are lost** (graceful degradation, spec §3.2). The store
`transaction_id` is the server's money-dedup key; `purchase_attempt_id` is the
context-join key — two keys, two jobs.

## Configuration (`init` options)

| Knob | Default | Notes |
|---|---|---|
| `session_inactivity_timeout_min` | `30` | Mirrors the server knob; **no remote-config in v1 — keep the two in agreement by hand.** Drift changes session *boundaries* only. |
| `batch_max_events` / `flush_interval_ms` | `50` / `10000` | Flush on size or interval, whichever first. |
| `offline_queue_max_events` | `10000` | Drop-oldest at the cap (a `queue_overflow` count is visible in debug). |
| `retry_backoff_base_ms` / `retry_backoff_max_ms` | `2000` / `300000` | Exponential + full jitter. |
| `storage` | `auto` | `auto` prefers IndexedDB → localStorage → memory. |
| `batch_max_bytes` | `60000` | Per-POST byte cap; the unload flush stays under the ~64 KB beacon cap. |
| `compress` | `auto` | gzip via `CompressionStream` where available. |
| `event_ttl_ms` | `82800000` (23 h) | Non-money events older than this are dropped before send (honors the 24 h server dedup window). |
| `debug` | `false` | Local rejections, drop counters, transport errors → console. |

## Reliability contract

- **At-least-once.** A crash between send and ack re-sends events with their
  **original `event_id`** (never re-minted); the server's 24 h windowed dedup
  absorbs the redelivery. Retries re-stamp `client_sent_time` but never
  `client_event_time`.
- **Never blocks gameplay.** A capture returns after a durable enqueue; transport
  and retry run off the hot path.
- **Never throws into game code.** Storage quota/write failures evict-oldest and
  count; they never surface as an exception.

## Versioning

Package **semver** moves independently of the **wire version** (which stays `v:1`
additive-only forever). The `sdk.version` on every batch is provenance, not
protocol. Releases are cut via changesets; CI publishes on tag via npm trusted
publishing (OIDC) with provenance — no `NPM_TOKEN`.

## License

MIT — the embeddable SDK is MIT (GPL-2.0-compatible) even though the platform is
Apache-2.0, so it can ship inside third-party game builds.

[009-client-sdk]: ../../specs/009-client-sdk/spec.md
[@&lt;org&gt;/analytics-sdk-server]: ../sdk-server/README.md
