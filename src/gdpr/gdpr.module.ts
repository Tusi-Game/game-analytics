import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AppConfigModule } from '../config/app-config.module';
import { SecurityModule } from '../security/security.module';
import { ErasureService } from './erasure.service';
import { DsarService } from './dsar.service';
import { SPINE_ENUMERATION_PORT, TIER_A_DELETION_PORT, DSAR_EXPORT_PORT } from './erasure.ports';
import { SpineEnumerationPortImpl, TierADeletionPortImpl, DsarExportPortImpl } from './spine-erasure.ports';

/**
 * GDPR bounded context (T-00.72–79, ops-envelope §7/§9). Hosts the idempotent
 * four-tier {@link ErasureService} and the read-only {@link DsarService}.
 *
 * The cross-story spine ports are bound to the REAL implementations in
 * {@link ./spine-erasure.ports} — real bitmap reads + spine-family deletes /
 * detach across the seven per-user spine tables (USER_SPINE, ACTIVE_USER_DAY,
 * BALANCE_SNAPSHOT, PAYER_SPINE_EXT, PAYER_DAY, PAYER_PERIOD_SPEND,
 * PURCHASE_IDEMPOTENCY). Without this binding an operator erasure would delete
 * only IDENTITY_EDGE and leave every user_id-keyed spine row intact (P13 / Art.17
 * violation). The 002-scope no-ops in {@link ./default-erasure.ports} are kept
 * for isolated unit tests but are no longer wired into the running app.
 *
 * The admin surface that triggers these jobs is 011's; this module is the
 * data-layer job + contract.
 */
@Module({
  imports: [DatabaseModule, AppConfigModule, SecurityModule],
  providers: [
    ErasureService,
    DsarService,
    { provide: SPINE_ENUMERATION_PORT, useClass: SpineEnumerationPortImpl },
    { provide: TIER_A_DELETION_PORT, useClass: TierADeletionPortImpl },
    { provide: DSAR_EXPORT_PORT, useClass: DsarExportPortImpl },
  ],
  exports: [ErasureService, DsarService],
})
export class GdprModule {}
