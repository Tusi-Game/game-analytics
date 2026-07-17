import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { PanelController } from './panel.controller';

/**
 * Server-rendered operator panel (FR-007). Skeleton — serves a placeholder home
 * page rendered from `views/index.njk`. Nunjucks is registered as the view
 * engine in `main.ts`; static assets under `panel/public/` are served there via
 * `express.static`. Depends on DashboardModule for the JSON read model (called
 * in-process, no HTTP loopback) once later stories add data.
 */
@Module({
  imports: [CommonModule, DashboardModule],
  controllers: [PanelController],
})
export class PanelModule {}
