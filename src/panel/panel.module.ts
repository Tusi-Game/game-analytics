import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { SessionsModule } from '../sessions/sessions.module';
import { EconomyModule } from '../economy/economy.module';
import { MonetizationModule } from '../monetization/monetization.module';
import { ColdStorageModule } from '../cold-storage/cold-storage.module';
import { OperatorModule } from '../operator/operator.module';
import { PanelController } from './panel.controller';
import { PanelConfigService } from './panel-config.service';
import { PanelSessionGuard } from './auth/panel-session.guard';
import { GameAccessGuard } from './auth/game-access.guard';
import { AuthController } from './auth/auth.controller';
import { GamesController } from './games/games.controller';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { EconomyController } from './metrics/economy.controller';
import { RetentionController } from './metrics/retention.controller';
import { MonetizationController } from './metrics/monetization.controller';
import { SessionsController } from './metrics/sessions.controller';
import { ConfigController } from './config/config.controller';
import { OpsController } from './ops/ops.controller';
import { OperatorsController } from './operators/operators.controller';

/**
 * Server-rendered operator panel (spec 012). A pure-presentation NestJS MVC module
 * embedded in the same process as ingest/workers/dashboard (SC-009 — one
 * docker-compose up). It CONSUMES the read services + operator control plane
 * in-process (no HTTP loopback): DashboardModule (ReadModelService,
 * ExceptionReadService), SessionsModule (SessionReadService, RetentionReadService),
 * EconomyModule (EconomyReadService), MonetizationModule (MonetizationReadService),
 * ColdStorageModule (UploadStatusReadModel), and OperatorModule (auth/session/MFA,
 * CredentialService, ConfigAdminService, GdprAdminService, OperatorAdminService).
 *
 * The panel is a PURE READER of every metric result; its only writes flow through
 * the sanctioned operator write services (credentials, config, GDPR, operator
 * accounts) and the short-lived panel:* Redis show-once flag. Nunjucks + static
 * are wired in main.ts; the Tailwind build runs at image build (npm run build).
 */
@Module({
  imports: [
    CommonModule,
    DashboardModule,
    SessionsModule,
    EconomyModule,
    MonetizationModule,
    ColdStorageModule,
    OperatorModule,
  ],
  // Controller ORDER is load-bearing: Express matches routes in registration
  // order, so every controller with STATIC `/panel/*` sub-paths (login, games,
  // operators) MUST be registered BEFORE the controllers that own the `:gameId`
  // wildcard (dashboard/metrics/config/ops) — otherwise `/panel/operators` would
  // match `/panel/:gameId` and 404 in GameAccessGuard ("game 'operators' not
  // found"). AuthController + GamesController + OperatorsController first; the
  // wildcard controllers last.
  controllers: [
    PanelController,
    AuthController,
    GamesController,
    OperatorsController,
    DashboardController,
    EconomyController,
    RetentionController,
    MonetizationController,
    SessionsController,
    ConfigController,
    OpsController,
  ],
  providers: [PanelConfigService, DashboardService, PanelSessionGuard, GameAccessGuard],
})
export class PanelModule {}
