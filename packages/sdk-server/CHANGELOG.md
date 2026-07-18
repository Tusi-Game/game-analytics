# @analytics-platform/analytics-sdk-server

## 0.1.0

Initial release (spec 010-server-sdk). Node server analytics SDK — the trusted
money/economy path:

- `init` with server-credential (`sk_`) prefix fail-fast (a public `pk_` client
  key is refused before any network call — no silent provenance downgrade).
- `verifiedPurchase` → one authoritative `kind=purchase`, `source=server` row
  with the full [006-monetization §3] field set; relays `purchase_attempt_id`;
  no local dedup (durable `transaction_id` gate is truth); no FX / normalized
  amount ever.
- `economy` (server-provenance), `track`.
- Money-aware bounded queue: non-money overflow is dropped-and-counted; a
  verified purchase that cannot enqueue surfaces synchronously (money is never
  silently dropped).
- At-least-once transport (bearer over TLS, `v:1` + `sdk` descriptor,
  `sdk.name=analytics-sdk-server`), backoff + jitter, `retry_max_elapsed_ms`
  budget → `on_error`, `flush_on_purchase`, `event_id` preserved across retry.
- Never breaks checkout: emit calls enqueue and return; failures route to
  `on_error`, never thrown in the payment path.
- ESM + CJS + `.d.ts`, Node ≥ 20, minimal dependency surface.
