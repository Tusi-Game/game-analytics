# @tusi-game/analytics-sdk

## 0.2.0

### Minor Changes

- 7b21d10: Initial 0.1.0 release of the two publishable SDK packages (specs 009-client-sdk +
  010-server-sdk): the browser/game client SDK (sessions, offline queue, zero-money
  purchase companion) and the Node server SDK (trusted verified-purchase + economy
  emission). Wire `v:1`, `/v1/events`, bearer auth; SDK semver decoupled from the
  wire version.

## 0.1.0

Initial release (spec 009-client-sdk). Client / browser analytics SDK:

- One-call `init` with client-key (`pk_`) prefix fail-fast (a secret `sk_`
  credential is refused before any network call).
- Capture verbs: `track`, `economy`, `newPurchaseAttempt`, `purchaseContext`
  (zero-money companion), `identify` (+ one-off alias edge), `appClose`, `flush`.
- Session tracker executing [003-sessions §1]: lazy start, monotonic inactivity
  timer, single terminal event, reconcile-at-init.
- Persistent offline queue (IndexedDB → localStorage → memory), bounded
  drop-oldest, client-side TTL (23 h), at-least-once transport with backoff +
  jitter, `client_sent_time` stamped at flush, `sendBeacon` unload tail-flush.
- Wire `v:1`, mandatory `sdk` descriptor, `/v1/events`, bearer auth.
- Zero runtime dependencies; ESM + CJS + browser-global + `.d.ts`.
