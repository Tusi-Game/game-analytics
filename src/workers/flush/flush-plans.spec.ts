import { buildFlushStatement } from './flush-merge';
import { CNT_FLUSH_PLAN, EXC_FLUSH_PLAN, CAT_FLUSH_PLAN, isExcBucket, partitionCntBuckets } from './flush-plans';
import { SEEDED_MARKER_FIELD } from '../../common/redis-keys/rehydrate';
import { CAT_FIELD_COUNT, CAT_FIELD_FIRST_SEEN, CAT_FIELD_LAST_SEEN } from '../kernel/postgres-floor.provider';
import { CAT_FIELD_EVENT_NAME, CAT_FIELD_GAME_ID, CAT_FIELD_KIND, CAT_PTS_PREFIX } from '../kernel/hot-bucket.writer';
import { EXC_FIELD_GAME_ID, EXC_FIELD_UTC_DAY } from '../kernel/exception-tally.writer';

/**
 * Flush projectors (T-01.15/16). Pure hash→FlushRow projection — no Redis/PG.
 * Proves each projector strips reserved/bookkeeping fields, builds the right PK,
 * and that the cnt-domain partition routes day-count vs exc buckets correctly.
 */

describe('flush projectors', () => {
  it('partitions the shared cnt domain into day-count vs exception buckets', () => {
    const { cntKeys, excKeys } = partitionCntBuckets([
      'game-42:cnt:2026-07-18',
      'game-42:cnt:2026-07-18:exc',
      'game-99:cnt:2026-07-19',
    ]);
    expect(cntKeys).toEqual(['game-42:cnt:2026-07-18', 'game-99:cnt:2026-07-19']);
    expect(excKeys).toEqual(['game-42:cnt:2026-07-18:exc']);
    expect(isExcBucket('game-42:cnt:2026-07-18:exc')).toBe(true);
    expect(isExcBucket('game-42:cnt:2026-07-18')).toBe(false);
  });

  it('cnt projector → EVENT_DAY_COUNT rows (marker stripped, PK from key)', () => {
    const rows = CNT_FLUSH_PLAN.project('game-42:cnt:2026-07-18', {
      login: '5',
      other: '20',
      [SEEDED_MARKER_FIELD]: '1',
    });
    expect(rows).toEqual([
      { pk: { game_id: 'game-42', event_name: 'login', utc_day: '2026-07-18' }, values: { count: '5' } },
      { pk: { game_id: 'game-42', event_name: 'other', utc_day: '2026-07-18' }, values: { count: '20' } },
    ]);
    // and the generated SQL is a class-M GREATEST upsert (idempotent on retry).
    const { sql } = buildFlushStatement(CNT_FLUSH_PLAN.spec, rows[0]!);
    expect(sql).toContain('event_day_count');
    expect(sql).toContain('GREATEST');
  });

  it('exc projector → EXCEPTION_TALLY rows keyed by (game, day, reason)', () => {
    const rows = EXC_FLUSH_PLAN.project('game-42:cnt:2026-07-18:exc', {
      nameless: '40',
      unparseable: '12',
      [EXC_FIELD_GAME_ID]: 'game-42',
      [EXC_FIELD_UTC_DAY]: '2026-07-18',
      [SEEDED_MARKER_FIELD]: '1',
    });
    expect(rows).toContainEqual({
      pk: { game_id: 'game-42', utc_day: '2026-07-18', reason: 'nameless' },
      values: { count: '40' },
    });
    expect(rows).toContainEqual({
      pk: { game_id: 'game-42', utc_day: '2026-07-18', reason: 'unparseable' },
      values: { count: '12' },
    });
    expect(rows).toHaveLength(2); // metadata + marker fields excluded
  });

  it('cat projector → one EVENT_CATALOG row, first_seen=LEAST column, pts reassembled', () => {
    const rows = CAT_FLUSH_PLAN.project('game-42:cat:level_start', {
      [CAT_FIELD_GAME_ID]: 'game-42',
      [CAT_FIELD_EVENT_NAME]: 'level_start',
      [CAT_FIELD_KIND]: 'generic',
      [CAT_FIELD_COUNT]: '7',
      [CAT_FIELD_FIRST_SEEN]: String(Date.parse('2026-07-18T00:00:00Z')),
      [CAT_FIELD_LAST_SEEN]: String(Date.parse('2026-07-18T12:00:00Z')),
      [`${CAT_PTS_PREFIX}level`]: JSON.stringify(['int', 'string']),
      [SEEDED_MARKER_FIELD]: '1',
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.pk).toEqual({ game_id: 'game-42', event_name: 'level_start' });
    expect(row.values.lifetime_count).toBe('7');
    expect(row.values.property_type_sets).toEqual({ level: ['int', 'string'] });
    // The merge SQL applies LEAST to first_seen (DARK-SPOT #2) and GREATEST to the rest.
    const { sql } = buildFlushStatement(CAT_FLUSH_PLAN.spec, row);
    expect(sql).toMatch(/first_seen"?\s*=\s*LEAST/);
    expect(sql).toContain('GREATEST');
  });

  it('exc projector skips when metadata (game/day) not yet seeded', () => {
    const rows = EXC_FLUSH_PLAN.project('game-42:cnt:2026-07-18:exc', { nameless: '1' });
    expect(rows).toEqual([]);
  });
});
