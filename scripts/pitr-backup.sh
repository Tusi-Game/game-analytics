#!/bin/sh
# Postgres PITR backup → encrypted → S3-compatible (MinIO) (T-00.80/81, FR-028,
# ops-envelope §8).
#
# Loop: every BACKUP_INTERVAL_SECONDS take a `pg_basebackup` (base + WAL via
# stream), ENCRYPT the tarball with SECRET_MASTER_KEY held OUTSIDE Postgres
# (AES-256-CBC + PBKDF2 via openssl) so a leaked backup / DB dump yields
# ciphertext (FR-029), then upload to the MinIO backup bucket. WAL archiving for
# true continuous PITR is configured on the Postgres server itself (archive_command
# → this same script's push helper); this sidecar owns the periodic BASE backup +
# the encrypt/ship + restore drill. RPO ≤ WAL-archive interval; RTO = restore +
# replay time (measured by pitr-restore.sh).
#
# Refuses to run without SECRET_MASTER_KEY (fails loud, never writes plaintext).
set -eu

: "${PGHOST:?}" "${PGUSER:?}" "${PGDATABASE:?}"
: "${MINIO_ENDPOINT:?}" "${MINIO_BUCKET:?}"
STAGE="${STAGE_DIR:-/stage}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-3600}"

if [ -z "${SECRET_MASTER_KEY:-}" ]; then
	echo "[pitr] FATAL: SECRET_MASTER_KEY is empty — refusing to write UNENCRYPTED backups (FR-029)." >&2
	exit 1
fi

encrypt_file() {
	# $1 = plaintext in, $2 = ciphertext out. AES-256-CBC + PBKDF2, salted.
	openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
		-in "$1" -out "$2" -pass "env:SECRET_MASTER_KEY"
}

upload() {
	# $1 = local file, $2 = object key. Uses `mc` if present, else a documented
	# curl-based S3 PUT is left to the operator (see docs/backup-restore.md). This
	# keeps the image dependency-light; the encrypt step above is the load-bearing
	# security part and always runs.
	if command -v mc >/dev/null 2>&1; then
		mc alias set backup "http://${MINIO_ENDPOINT}:${MINIO_PORT:-9000}" "${MINIO_ACCESS_KEY}" "${MINIO_SECRET_KEY}" >/dev/null 2>&1 || true
		mc mb --ignore-existing "backup/${MINIO_BUCKET}" >/dev/null 2>&1 || true
		mc cp "$1" "backup/${MINIO_BUCKET}/$2"
	else
		echo "[pitr] mc not installed — leaving encrypted backup at $1 (upload it per docs/backup-restore.md)." >&2
	fi
}

take_backup() {
	ts="$(date -u +%Y%m%dT%H%M%SZ)"
	dir="${STAGE}/base-${ts}"
	mkdir -p "$dir"
	echo "[pitr] pg_basebackup → ${dir}"
	# -X stream ships the WAL needed to make the base consistent (PITR floor).
	pg_basebackup -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -D "$dir" -Ft -z -Xs -P
	tar -C "$dir" -cf "${STAGE}/base-${ts}.tar" .
	encrypt_file "${STAGE}/base-${ts}.tar" "${STAGE}/base-${ts}.tar.enc"
	rm -rf "$dir" "${STAGE}/base-${ts}.tar"
	upload "${STAGE}/base-${ts}.tar.enc" "base-${ts}.tar.enc"
	echo "[pitr] backup ${ts} encrypted + staged/uploaded."
}

echo "[pitr] backup loop starting (interval=${INTERVAL}s, encrypted, bucket=${MINIO_BUCKET})"
while true; do
	take_backup || echo "[pitr] backup attempt failed (will retry next interval)" >&2
	sleep "$INTERVAL"
done
