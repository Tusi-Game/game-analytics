/**
 * Default (002-scope) erasure/DSAR port implementations.
 *
 * 002 owns no spine family, so the enumeration/deletion/export ports are no-ops
 * that later specs (003/004/006) override with real bitmap reads + spine deletes.
 * The no-op posture is DELIBERATELY idempotent — enumerating no days and deleting
 * nothing makes every re-run a no-op, which is exactly the erasure-job invariant.
 *
 * "All sealed" defaults to TRUE with zero days: an erasure request against a
 * platform with no spine data has nothing to wait for, so the destructive pass
 * (the 002-owned IDENTITY_EDGE delete) runs immediately.
 */

import { Injectable } from '@nestjs/common';
import type { SpineEnumerationPort, TierADeletionPort, DsarExportPort } from './erasure.ports';

@Injectable()
export class NoSpineEnumerationPort implements SpineEnumerationPort {
  async enumerateDays(_gameId: string, _userId: string): Promise<{ days: string[]; allSealed: boolean }> {
    // No spine in 002 → no activity/payer days to wait on; vacuously all-sealed.
    return { days: [], allSealed: true };
  }
}

@Injectable()
export class NoopTierADeletionPort implements TierADeletionPort {
  async deleteSpineFamily(): Promise<void> {
    // No spine family exists in 002; later specs delete USER_SPINE / PAYER_* /
    // BALANCE_SNAPSHOT and scrub membership sets here.
  }
}

@Injectable()
export class EmptyDsarExportPort implements DsarExportPort {
  async assembleSpineExport(_gameId: string, _userId: string): Promise<Record<string, unknown>> {
    // No spine family yet — later specs add active_days_bitmap, PAYER_SPINE_EXT,
    // PAYER_PERIOD_SPEND, PURCHASE_IDEMPOTENCY here.
    return { note: 'no spine-family data (002 scope); later specs populate this section' };
  }
}
