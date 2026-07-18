/**
 * GDPR erasure/DSAR cross-story SEAMS (T-00.72–78, ops-envelope §7/§9).
 *
 * The four-tier erasure posture (Q7) deletes structures owned by LATER specs
 * (003 sessions `USER_SPINE`/`ACTIVE_USER_DAY`, 006 monetization
 * `PAYER_*`/`PURCHASE_IDEMPOTENCY`, 004 economy `BALANCE_SNAPSHOT`). Those tables
 * do not exist in 002. Rather than block, 002 OWNS the job + the tiered CONTRACT
 * and delegates the per-tier destructive work to pluggable ports that later specs
 * implement. The default no-op ports make the job runnable + testable in 002
 * (they delete nothing, so re-runs stay idempotent by construction).
 *
 * 002 itself owns `IDENTITY_EDGE` (holds user_id, operational) — the erasure job
 * deletes it directly (not via a port); everything else is delegated.
 */

/** DI token for the spine day-enumeration port (reads activity/payer days). */
export const SPINE_ENUMERATION_PORT = 'SPINE_ENUMERATION_PORT';
/** DI token for the tier-(a) destructive-deletion port (spine family). */
export const TIER_A_DELETION_PORT = 'TIER_A_DELETION_PORT';
/** DI token for the DSAR (Art.15/20) export-assembly port (spine family read). */
export const DSAR_EXPORT_PORT = 'DSAR_EXPORT_PORT';

/**
 * Enumerate the days a subject was active/paying, and whether ALL of them are
 * sealed (the wait-for-seal gate, ops-envelope §7.4). The bitmap MUST be read
 * BEFORE anything deletes it (T-00.72 op-order). Later specs read
 * `active_days_bitmap` + `PURCHASE_IDEMPOTENCY.purchase_day`.
 */
export interface SpineEnumerationPort {
  /**
   * @returns the enumerated activity/payer days (UTC "YYYY-MM-DD") and whether
   * every enumerated day is already sealed. 002 default: no spine → no days,
   * all-sealed vacuously true (so the destructive pass may proceed).
   */
  enumerateDays(gameId: string, userId: string): Promise<{ days: string[]; allSealed: boolean }>;
}

/**
 * The tier-(a) HARD-DELETE / SCRUB pass over the spine family (ops-envelope §7.1)
 * for a subject's enumerated days. Idempotent: re-runs no-op on absent rows /
 * already-scrubbed members. `purchaseMode` selects detach (default; tombstone
 * user_id, keep money row) vs delete.
 */
export interface TierADeletionPort {
  deleteSpineFamily(input: {
    gameId: string;
    userId: string;
    days: string[];
    purchaseMode: 'detach' | 'delete';
  }): Promise<void>;
}

/**
 * The DSAR (Art. 15/20) read-only export assembly over the spine family
 * (ops-envelope §9). Symmetric to erasure's enumeration; returns a
 * machine-readable object. 002 default: an empty spine section (no per-user
 * structures exist yet) — the export still assembles the 002-owned parts.
 */
export interface DsarExportPort {
  assembleSpineExport(gameId: string, userId: string): Promise<Record<string, unknown>>;
}
