# Deployment requirements (ops-envelope §8–§10)

> Doc for the deploy prerequisites Units 1+3 flagged and Unit 4 closes:
> slewing NTP (T-00.6), TLS reverse proxy (T-00.7 / T-00.85), Redis maxmemory
> (T-00.4), digest-pinned images (T-00.3, see `docs/docker-offline.md`).

## 1. Slewing NTP — HARD requirement (T-00.6, Foundation §4.2)

Containers inherit the HOST clock. Skew-correction (§4.2) and the monotonicity
alarm assume the server clock never JUMPS backward. A stepped clock (`ntpd -g`,
`step-on-start`, a manual `date` set) breaks both.

**Run a slewing time daemon on the host** with a bounded slew rate, never a
stepping one. `chronyd` example (`/etc/chrony/chrony.conf`):

```
pool time.cloudflare.com iburst
# Slew (adjust rate), never step, once running:
makestep 1.0 3          # allow a step ONLY in the first 3 updates at boot
maxslewrate 1000        # bound the slew so corrections are gradual
rtcsync
```

The single-VPS posture keeps this on the HOST (not a privileged time-daemon
container, which would need host-clock capabilities). Verify with `chronyc
tracking`; alert if `System time` drift grows or the source is lost.

## 2. TLS reverse proxy (T-00.7 / T-00.85)

`docker compose --profile proxy up` starts Caddy (`deploy/Caddyfile`) terminating
TLS and forwarding `X-Forwarded-Proto` to the app. Set the app `REQUIRE_TLS=true`
so the ingest guard refuses plain-HTTP bearer auth (a credential is never
accepted in the clear). See `docs/reverse-proxy.md` for the sanctions/shutdown
cert guidance (DNS-01 via external nameserver, long-lived certs, expiry alerting).

## 3. Redis maxmemory (T-00.4)

`redis --maxmemory 3800mb --maxmemory-policy noeviction` is set in
`docker-compose.yml`; the app's `REDIS_MAXMEMORY_BYTES` MUST match it so the door
watermark (80 % ≈ 3 GB) brakes before `noeviction` OOM. Lower BOTH together on a
smaller VPS. AOF `everysec` + `--no-appendfsync-on-rewrite yes`; raw dir on a
separate volume from the AOF.

## 4. Secrets (FR-029)

`SECRET_MASTER_KEY` MUST be set in production (env / Docker secret / file mount) —
it is the out-of-DB master key for envelope-encryption of reversible secrets AND
the per-game erasure-ledger `subject_ref` hash key. The app boot health check
(`/health`) reports whether it is configured; the PITR sidecar refuses to run
without it. Server credentials / `sdk_key` stay one-way hashed (already correct).

## 5. Single-command posture (P4, SC-009)

The DEFAULT `docker compose up` still brings the whole app + Redis + Postgres +
MinIO up with no certs and no extra profiles — the `proxy` and `backup` services
are behind opt-in profiles so a dev box is one command, while a production deploy
adds `--profile proxy --profile backup`.
