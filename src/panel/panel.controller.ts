import { Controller, Get, Render, UseGuards } from '@nestjs/common';
import { OperatorSessionGuard } from '../common/guards/operator-session.guard';

/**
 * Panel home (SKELETON). `@Render('index')` resolves to `index.njk` via the
 * Nunjucks engine configured in `main.ts`. Later stories add the real operator
 * views and data. The operator-session guard is a no-op skeleton for now.
 */
@Controller()
@UseGuards(OperatorSessionGuard)
export class PanelController {
  @Get()
  @Render('index')
  home(): { title: string; heading: string } {
    return {
      title: 'Analytics Platform',
      heading: 'Analytics Platform',
    };
  }
}
