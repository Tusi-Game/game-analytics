# Reference reverse proxy & TLS (ops-envelope §9, T-00.7)

Config: `deploy/Caddyfile`, run via `docker compose --profile proxy up`.

## TLS is normative

All bearer-credential + event traffic requires TLS — plain HTTP exposes every
credential and payload. Caddy terminates TLS and forwards `X-Forwarded-Proto` so
the app's `IngestAuthGuard` (with `REQUIRE_TLS=true`) refuses any request that did
not arrive over TLS. The app binds behind the proxy; do not expose port 3000
publicly in a TLS deploy.

## Sanctions / internet-shutdown guidance

During an internet shutdown (e.g. Iran), Let's Encrypt **HTTP-01 AND DNS-01** can
both fail and certs expire → HTTPS goes dark. Mitigations:

- **DNS-01 via an EXTERNAL nameserver** — validation via an offshore DNS API does
  not need inbound reachability. Add a `tls { dns <provider> <token> }` block.
- **Long-lived certs** where the CA allows, or a commercial cert bought ahead.
- **Cert-expiry monitoring + alerting** — alert well before expiry so a stalled
  renewal is caught before the cert lapses (a lapsed cert = full ingest outage).
  A simple external check (`openssl s_client -connect host:443 | openssl x509
  -noout -enddate`) on a cron with an alert is enough.

## Origin check (client builds)

Set the app `ALLOWED_ORIGINS=https://yourgame.example,https://…` to reject web
(client-provenance) requests from other origins (defeats casual curl abuse of the
public `sdk_key`). Server-to-server callers send no `Origin` and are unaffected.
`provenance=client` metrics remain best-effort/untrusted regardless — the rate
cap is a throttle, not an integrity control.

## Optional HMAC on the server path

A documented defense-in-depth lever if TLS is ever compromised: HMAC on the
server-credential path (server-to-server, key never shipped in a build). Not in
v1; TLS + hashed credentials are the baseline.
