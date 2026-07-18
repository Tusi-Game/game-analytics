# @tusi-game/analytics-sdk-server

> The npm package is `@tusi-game/analytics-sdk-server`. The **wire** identifier
> `sdk.name = "analytics-sdk-server"` is stable regardless of the npm scope, so
> changing the publish scope never changes the on-the-wire protocol.

The Node **server** analytics SDK for the self-hostable analytics platform (spec
[010-server-sdk]). Your trusted backend — the service that already validates
store receipts with Apple/Google — drops it in and emits the two things the
platform treats as **truth**: verified purchase rows (money) and server-granted
economy flows.

- **Trust posture.** Authenticates with a **secret** `server_credential`
  (`sk_…`); every event is server-stamped `provenance = server` — the only events
  eligible for revenue. **This credential must never ship inside a game build** —
  that is why it is a separate package from [@tusi-game/analytics-sdk].
- **No receipt validation here.** Your backend validates receipts (or delegates
  to its payment stack) and passes the *outcome*; this SDK ships the
  already-verified row.
- **Never emits `session` events** — activeness is client-session-anchored.

## Install

```bash
npm install @tusi-game/analytics-sdk-server
```

## Quickstart

```ts
import { AnalyticsServer } from '@tusi-game/analytics-sdk-server';

const analytics = AnalyticsServer.init({
  serverCredential: process.env.ANALYTICS_SERVER_CREDENTIAL!, // NEVER inline
  endpoint: 'https://analytics.example.com',
});

// ...after YOUR OWN receipt validation with Apple/Google...
analytics.verifiedPurchase({
  userId: 'u-123',
  transactionId: 'txn_abc',           // store money-dedup + audit key
  originalTransactionId: 'otxn_abc',  // stable across renewal/restore
  productId: 'gem_bundle_large',
  productCategory: 'consumable',
  priceLocal: 4.99,                   // raw charged amount — NEVER normalized here
  currency: 'USD',
  verified: true,                     // outcome of YOUR validation
  environment: 'prod',                // 'sandbox' is accepted-but-ineligible
  purchaseAttemptId: attemptIdFromClient, // relayed from the client (see below)
});

// On graceful shutdown:
process.on('SIGTERM', () => { void analytics.shutdown(); });
```

## Credential handling (Q2 posture)

- Read `server_credential` from an **environment variable or secret manager**
  (`ANALYTICS_SERVER_CREDENTIAL` by convention). **Never inline it in source** —
  it is show-once, stored hashed server-side; a leak makes an attacker's events
  money-truth.
- Credentials are **prefix-typed**. `init` fails fast (before any network call)
  if handed a public `pk_` client key — a config error, never a silent downgrade.
- Rotation is **dual-active** (issued via the operator admin surface): a backend
  can migrate credentials with zero downtime; the SDK holds one valid credential
  at a time in config.

## Segmented purchases: read back `purchase_attempt_id`

The client SDK mints a `purchase_attempt_id` and threads it into the store call
(`appAccountToken` / `obfuscatedAccountId`). Read it back from the validated
transaction and pass it to `verifiedPurchase` so the platform can join the
authoritative revenue row to the client's purchase-context companion:

- **StoreKit 2** → `Transaction.appAccountToken`
- **Google Play** → `obfuscatedAccountId` on the purchase

**If you cannot relay it, the purchase still counts** — only the segmented
dimensions are lost (graceful degradation). The store `transaction_id` remains
the money-dedup key; `purchase_attempt_id` is the context-join key.

## Crash recovery (no durable spool in v1)

The outbound queue is in-memory. A process crash loses the un-acked queue —
**re-emit from your own payment records on restart**. This is safe by design: the
platform's durable `transaction_id` gate dedups a re-emitted purchase at any
lateness, so re-emitting never double-counts. `flush_on_purchase` (default on)
shrinks the crash-loss window to near-zero for the events that matter most.

## Money is never silently dropped

`verifiedPurchase` is non-blocking like every emit call — **except** if the
outbound queue is full and cannot make room, it throws `QueueOverflowError`
**synchronously**. Non-money events (economy, generic) over the bound are
dropped-and-counted via `on_error`; money is not. All other failures route to
`on_error` and **never throw in your payment path**.

## Configuration (`init` options)

| Knob | Default | Meaning |
|---|---|---|
| `flush_interval_ms` | `5000` | background flush cadence |
| `batch_max_events` | `100` | max envelopes per POST |
| `flush_on_purchase` | `true` | `verifiedPurchase` triggers an immediate flush |
| `retry_backoff_base_ms` / `retry_backoff_max_ms` | `1000` / `60000` | exp backoff + jitter |
| `retry_max_elapsed_ms` | `900000` (15 min) | per-batch retry budget before surfacing to `on_error` |
| `queue_max_events` | `10000` | outbound bound (money never silently dropped) |
| `on_error` / `debug` | no-op / `false` | failure + diagnostics hook; never throws |

## Versioning

Package **semver** is decoupled from the **wire version** (`v:1` forever) and
from the stable wire `sdk.name`. Releases are cut via changesets; CI publishes on
tag via npm trusted publishing (OIDC) with provenance — no `NPM_TOKEN`.

## License

MIT.

[010-server-sdk]: ../../specs/010-server-sdk/spec.md
[@tusi-game/analytics-sdk]: ../sdk-client/README.md
