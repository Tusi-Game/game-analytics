/**
 * DSAR access/portability job (T-00.78, GDPR Art. 15/20, ops-envelope §9) — the
 * read-only twin of the erasure job. Given a `user_id`, assemble a
 * machine-readable export of the subject's personal data.
 *
 * Art. 11 boundary (documented in the export): aggregate cells that no longer
 * contain an identifier are OUT OF SCOPE — EVENT_DAY_COUNT / EVENT_CATALOG /
 * EXCEPTION_TALLY are aggregate statistics with no per-user identifier, so they
 * are not part of a subject's export. The per-user spine family IS in scope (it
 * can identify by user_id) — delegated to the DsarExportPort (later specs).
 *
 * 002 owns IDENTITY_EDGE (an anon→user link that identifies) → included here.
 * The admin SURFACE that triggers/downloads this is 011's; this service is the
 * data-assembly job + contract only.
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IdentityEdgeEntity } from '../database/entities/identity-edge.entity';
import { DSAR_EXPORT_PORT, type DsarExportPort } from './erasure.ports';

export interface DsarExport {
  game_id: string;
  /** The subject's user_id — echoed for the operator's confirmation. */
  user_id: string;
  generated_at: string;
  /** The GDPR Art. 11 scope note (aggregate cells excluded). */
  scope_note: string;
  /** 002-owned operational identity edges for the subject. */
  identity_edges: Array<{ anon_id: string; first_linked_at: string }>;
  /** The spine-family export section (populated by later specs via the port). */
  spine: Record<string, unknown>;
}

const SCOPE_NOTE =
  'Aggregate statistics (event day counts, catalog, exception tallies) contain no ' +
  'per-user identifier and are excluded per GDPR Art. 11 / Recital 26. The ' +
  'per-user spine family and operational identity edges — which can identify by ' +
  'user_id — are included.';

@Injectable()
export class DsarService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(DSAR_EXPORT_PORT) private readonly exporter: DsarExportPort,
  ) {}

  /** Assemble the subject's machine-readable data export (read-only). */
  async assemble(gameId: string, userId: string): Promise<DsarExport> {
    const edges = await this.dataSource
      .getRepository(IdentityEdgeEntity)
      .find({ where: { gameId, userId }, select: { anonId: true, firstLinkedAt: true } });

    const spine = await this.exporter.assembleSpineExport(gameId, userId);

    return {
      game_id: gameId,
      user_id: userId,
      generated_at: new Date().toISOString(),
      scope_note: SCOPE_NOTE,
      identity_edges: edges.map((e) => ({
        anon_id: e.anonId,
        first_linked_at: e.firstLinkedAt.toISOString(),
      })),
      spine,
    };
  }
}
