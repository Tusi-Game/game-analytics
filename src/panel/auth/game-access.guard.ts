/**
 * GameAccessGuard (T-11.22) — enforces FR-002 / SC-003 game isolation for every
 * game-scoped panel route (`/panel/:gameId/...`). It extracts the `gameId` param,
 * loads the `GAME` registry row, attaches it to `request.game`, and 404s when the
 * game does not exist. There is no per-game permission model in v1 (spec §3.2:
 * all operators with dashboard access can view all games — single-tenant studio),
 * so this guard establishes existence + scoping, not per-operator ACL.
 *
 * Isolation itself comes from the controllers passing the validated `gameId` into
 * the per-game read services (which are all `gameId`-first) — this guard makes an
 * unknown/wrong game a hard 404 so a view can never silently render another
 * game's data.
 */

import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GameEntity } from '../../database/entities/game.entity';
import type { OperatorRequest } from '../../operator/operator-request';

/** The panel request augmented with the resolved game (stamped by this guard). */
export interface GameScopedRequest extends OperatorRequest {
  game?: GameEntity;
}

@Injectable()
export class GameAccessGuard implements CanActivate {
  constructor(private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GameScopedRequest>();
    const gameId = request.params?.gameId;
    if (typeof gameId !== 'string' || gameId.length === 0) {
      throw new NotFoundException('game not found');
    }
    const game = await this.dataSource.getRepository(GameEntity).findOne({ where: { gameId } });
    if (!game) {
      throw new NotFoundException(`game "${gameId}" not found`);
    }
    request.game = game;
    return true;
  }
}
