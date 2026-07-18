/**
 * Panel view-engine + static wiring (spec §1) — extracted so BOTH the production
 * bootstrap (main.ts) and the e2e harness configure the panel identically. Without
 * this the panel's Nunjucks `res.render` and its `/styles`/`/scripts` static mount
 * only exist under `node dist/main.js`, and a raw `Test.createTestingModule` app
 * would 500 on every rendered view + 404 on assets.
 *
 * `__dirname` is `src/panel` under ts-node and `dist/panel` after `nest build`
 * (nest-cli copies panel/views + panel/public), so both paths resolve in both
 * runtimes.
 */

import type { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import * as nunjucks from 'nunjucks';
import { join } from 'path';

/** Configure the Nunjucks view engine + panel static assets on the app. */
export function configurePanel(app: NestExpressApplication): void {
  const viewsPath = join(__dirname, 'views');
  const publicPath = join(__dirname, 'public');

  const expressApp = app.getHttpAdapter().getInstance();
  nunjucks.configure(viewsPath, {
    express: expressApp,
    autoescape: true,
    watch: process.env.NODE_ENV === 'development',
  });
  app.setViewEngine('njk');

  // Static assets for the panel (styles, scripts, img) at `/styles`, `/scripts`,
  // `/img` — matching the template references and the existing mount.
  app.use(express.static(publicPath));
}
