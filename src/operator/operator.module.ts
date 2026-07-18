import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { SecurityModule } from '../security/security.module';
import { AppConfigModule } from '../config/app-config.module';
import { GdprModule } from '../gdpr/gdpr.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { PasswordService } from './password.service';
import { MfaService } from './mfa.service';
import { OperatorSessionService } from './operator-session.service';
import { OperatorAuthService } from './operator-auth.service';
import { CredentialService } from './credential.service';
import { LastUsedFlushService } from './last-used-flush.service';
import { GdprAdminService } from './gdpr-admin.service';
import { ConfigAdminService } from '../config/config-admin.service';
import { DataExistsService } from '../config/data-exists.service';
import { SecretRotationService } from '../security/secret-rotation.service';
import { OperatorSessionGuard } from './operator-session.guard';
import { RolesGuard } from './roles.guard';
import { OperatorAuthController } from './operator-auth.controller';
import { AdminGameController } from './admin-game.controller';
import { AdminConfigController } from './admin-config.controller';
import { AdminGdprController } from './admin-gdpr.controller';
import { AdminSecretController } from './admin-secret.controller';
import { AdminReadModelController } from './admin-read-model.controller';

/**
 * 011 operator/admin control plane (Units A + B) — API-ONLY (panel 012 consumes
 * it). No Nunjucks views.
 *
 * Unit A: operator auth (session/MFA/lockout/RBAC), game registration + the Q2
 * two-class credential lifecycle (dual-active rotation), and the R7 last_used_at
 * flush half. It is the SOLE human write-path into GAME + its credential children
 * (P9); the ingest resolver only READS them.
 *
 * Unit B adds:
 *  - the config admin write-path ({@link ConfigAdminService}, the SOLE config
 *    writer P9): forward-only GAME.config write + CONFIG_AUDIT, contract-validated
 *    against the config-contract registry, infra secrets envelope-encrypted, and
 *    the R13 reporting_offset SET-ONCE hard-block ({@link DataExistsService});
 *  - the GDPR admin surface ({@link GdprAdminService}) — SURFACES GdprModule's
 *    ErasureService/DsarService behind operator attestation + audit; and
 *  - the master-key rotation path ({@link SecretRotationService}, T-10.22).
 *
 * Imports GdprModule (erasure/DSAR jobs) + DashboardModule (the PG-direct result
 * read model) + AppConfigModule (GameConfigService reader). SecurityModule backs
 * the envelope crypto. All admin controllers sit behind OperatorSessionGuard +
 * RolesGuard.
 *
 * NOTE (R7 wiring): LastUsedFlushService.drain() is driven on the flush cadence
 * by IngestWorker (WorkersModule provides its own instance to avoid a
 * workers→operator import cycle); it is still provided/exported here for the
 * operator surface + its own tests.
 */
@Module({
  imports: [DatabaseModule, RedisModule, SecurityModule, AppConfigModule, GdprModule, DashboardModule],
  controllers: [
    OperatorAuthController,
    AdminGameController,
    AdminConfigController,
    AdminGdprController,
    AdminSecretController,
    AdminReadModelController,
  ],
  providers: [
    PasswordService,
    MfaService,
    OperatorSessionService,
    OperatorAuthService,
    CredentialService,
    LastUsedFlushService,
    // Unit B services.
    ConfigAdminService,
    DataExistsService,
    GdprAdminService,
    SecretRotationService,
    OperatorSessionGuard,
    RolesGuard,
  ],
  exports: [
    CredentialService,
    OperatorSessionService,
    OperatorAuthService,
    PasswordService,
    MfaService,
    LastUsedFlushService,
    ConfigAdminService,
    DataExistsService,
    GdprAdminService,
    SecretRotationService,
  ],
})
export class OperatorModule {}
