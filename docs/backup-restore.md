# Durability, backup & disaster recovery (ops-envelope §8, FR-028)

> Doc tasks T-00.82 (recovery order) · T-00.83 (Redis SPOF). Mechanism:
> `scripts/pitr-backup.sh` (sidecar `pitr`, compose profile `backup`) +
> `scripts/pitr-restore.sh`. The encryption boundary is proven by
> `src/security/backup-crypto.spec.ts`.

## 1. Postgres PITR — backed up, not assumed

- `docker compose --profile backup up -d` starts the `pitr` sidecar, which loops
  `pg_basebackup -Ft -z -Xs` every `BACKUP_INTERVAL_SECONDS`, ENCRYPTS the
  tarball with `SECRET_MASTER_KEY` (AES-256-CBC + PBKDF2, held OUTSIDE Postgres),
  and ships it to the MinIO `analytics-backup` bucket. `-Xs` streams the WAL
  needed to make the base consistent.
- For true continuous PITR, set Postgres `archive_mode = on` + an
  `archive_command` that pushes each WAL segment to the same bucket (encrypted).
  RPO ≤ the WAL-archive interval (default ≤ 5 min).
- **The sidecar refuses to run without `SECRET_MASTER_KEY`** — it never writes a
  plaintext backup (FR-029). A DB dump or a stolen backup then yields ciphertext.

## 2. Recovery order on TOTAL Postgres loss (T-00.82)

1. **Restore the latest encrypted BASE backup** — `scripts/pitr-restore.sh
   <base.tar.enc> <target-data-dir>` (decrypts with `SECRET_MASTER_KEY`, unpacks).
2. **Replay archived WAL** to the latest archived point — set a `restore_command`
   + `recovery_target` (or leave open-ended for "latest") and start Postgres
   against the restored dir. Durable results + spine recover to ≤ RPO.
3. **Raw-file manual rebuild is the SECONDARY floor** — only for the ≤ RPO window
   and for days whose backup predates a gap. Not the primary path.

RTO = measured base-restore + WAL-replay time. Run the restore drill on a
schedule (T-00.96) — the classic failure is a backup that exists but cannot
restore. `pitr-restore.sh` is that drill.

## 3. Encrypted at rest (T-00.81)

Backups are encrypted (above). Where the host supports it, put the Postgres data
directory on a filesystem-encrypted volume. The master key lives outside the DB
(env var / Docker secret / file mount), decrypted only in-worker.

## 4. Redis SPOF — named honestly (T-00.83)

A single un-replicated Redis is the platform's **availability** ceiling (NOT a
durability risk — nothing durable lives only in Redis). A Redis crash / OOM / VPS
reboot = 100 % ingest outage for all games until recovery; AOF replay of the
~1 GB steady state takes minutes (the RTO). Acceptable for the modest-VPS target,
but real.

**Optional HA lever (like the HLL/Bloom scale levers, forward-only):**
- Redis replica + Sentinel for failover;
- and/or split the queue Redis from the counter/dedup Redis so a counter-store
  OOM does not stop enqueue.

**AOF fsync-stall mitigation (already applied):** the raw-file directory
(`rawdata` volume) and the Redis AOF (`redisdata` volume) are on SEPARATE volumes
(a raw fsync must not starve the AOF fsync); `--no-appendfsync-on-rewrite yes` is
set. `appendfsync no` is acceptable if pushed, since the raw file is the real
durability floor and ≤ 1 s loss is already accepted.
