import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SdkKeyGuard } from '../common/guards/sdk-key.guard';
import { GameId } from '../common/decorators/game-id.decorator';
import type { BatchAck, BatchRequest } from '../common/contracts';

/**
 * Ingest front door (SKELETON). Real batch validation, routing, and enqueue are
 * spec 002's job. This placeholder proves the route, guard, and decorators are
 * wired and returns a fixed ack.
 */
@Controller('v1')
@UseGuards(SdkKeyGuard)
export class IngestController {
  @Post('events')
  @HttpCode(200)
  ingest(@Body() _batch: BatchRequest, @GameId() _gameId: string | undefined): BatchAck {
    // Placeholder — spec 002 validates, routes, and enqueues.
    return { received: 0, batch_id: 'placeholder' };
  }
}
