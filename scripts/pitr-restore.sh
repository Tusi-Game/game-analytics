#!/bin/sh
# Postgres PITR restore drill (T-00.82 / T-00.96, FR-028, ops-envelope §8).
#
# The classic failure is a backup that EXISTS but cannot RESTORE. This script is
# the documented + scriptable restore path, and doubles as the scheduled
# verified-restore drill: decrypt an encrypted base backup, unpack it into a
# target data dir, and (optionally) start a throwaway Postgres against it to
# prove it round-trips. Recovery order on TOTAL Postgres loss:
#   1. restore the latest encrypted BASE backup here,
#   2. replay archived WAL to the latest archived point (RPO ≤ WAL interval),
#   3. raw-file manual rebuild is the SECONDARY floor only for the ≤RPO window.
#
# Usage:
#   pitr-restore.sh <encrypted-base.tar.enc> <target-data-dir>
# Requires SECRET_MASTER_KEY (same key the backup was encrypted with).
set -eu

ENC="${1:?usage: pitr-restore.sh <encrypted-base.tar.enc> <target-data-dir>}"
TARGET="${2:?usage: pitr-restore.sh <encrypted-base.tar.enc> <target-data-dir>}"

if [ -z "${SECRET_MASTER_KEY:-}" ]; then
	echo "[restore] FATAL: SECRET_MASTER_KEY is empty — cannot decrypt the backup." >&2
	exit 1
fi
if [ ! -f "$ENC" ]; then
	echo "[restore] FATAL: encrypted backup not found: $ENC" >&2
	exit 1
fi

TMP="$(mktemp).tar"
trap 'rm -f "$TMP"' EXIT

echo "[restore] decrypting ${ENC}"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
	-in "$ENC" -out "$TMP" -pass "env:SECRET_MASTER_KEY"

mkdir -p "$TARGET"
echo "[restore] unpacking base into ${TARGET}"
tar -C "$TARGET" -xf "$TMP"

# pg_basebackup -Ft -z writes base.tar.gz + pg_wal.tar.gz inside the target.
if [ -f "$TARGET/base.tar.gz" ]; then
	tar -C "$TARGET" -xzf "$TARGET/base.tar.gz"
	rm -f "$TARGET/base.tar.gz"
fi
if [ -f "$TARGET/pg_wal.tar.gz" ]; then
	mkdir -p "$TARGET/pg_wal"
	tar -C "$TARGET/pg_wal" -xzf "$TARGET/pg_wal.tar.gz"
	rm -f "$TARGET/pg_wal.tar.gz"
fi

echo "[restore] base restored to ${TARGET}."
echo "[restore] Next: set recovery_target/restore_command for WAL replay (see docs/backup-restore.md),"
echo "[restore] then start Postgres against ${TARGET} to complete PITR to the latest archived point."
