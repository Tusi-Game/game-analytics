import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AppConfigModule } from '../config/app-config.module';
import { SecurityModule } from '../security/security.module';
import { ErasureService } from './erasure.service';
import { DsarService } from './dsar.service';
import { SPINE_ENUMERATION_PORT, TIER_A_DELETION_PORT, DSAR_EXPORT_PORT } from './erasure.ports';
import { NoSpineEnumerationPort, NoopTierADeletionPort, EmptyDsarExportPort } from './default-erasure.ports';

/**
 * GDPR bounded context (T-00.72–79, ops-envelope §7/§9). Hosts the idempotent
 * four-tier {@link ErasureService} and the read-only {@link DsarService}. The
 * cross-story spine ports default to 002-scope no-ops (later specs override the
 * bindings with real bitmap reads + spine deletes). The admin surface that
 * triggers these jobs is 011's; this module is the data-layer job + contract.
 */
@Module({
  imports: [DatabaseModule, AppConfigModule, SecurityModule],
  providers: [
    ErasureService,
    DsarService,
    { provide: SPINE_ENUMERATION_PORT, useClass: NoSpineEnumerationPort },
    { provide: TIER_A_DELETION_PORT, useClass: NoopTierADeletionPort },
    { provide: DSAR_EXPORT_PORT, useClass: EmptyDsarExportPort },
  ],
  exports: [ErasureService, DsarService],
})
export class GdprModule {}
