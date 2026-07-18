import { Controller, Get, Redirect } from '@nestjs/common';

/**
 * Panel root (T-11.1/4). The bare `/` route redirects to the panel's landing
 * view — the game list — so the platform host root lands an operator in the SSR
 * panel. This route is intentionally UNGUARDED: `/panel/games` is behind the
 * {@link PanelSessionGuard}, which redirects an unauthenticated operator to
 * `/panel/login`, so `/` → `/panel/games` → (if no session) `/panel/login`.
 *
 * The dead `common/guards/operator-session.guard.ts` skeleton that previously
 * decorated this controller has been retired (011 handoff); panel routes now use
 * the cookie-transport {@link PanelSessionGuard}.
 */
@Controller()
export class PanelController {
  @Get()
  @Redirect('/panel/games', 302)
  root(): void {
    // Redirect handled by the @Redirect decorator.
  }
}
