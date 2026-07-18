import { buildFlushStatement, INGEST_MERGE_SPECS, MergeTableSpec, assertSupportedTaxonomy } from './flush-merge';

/**
 * Flush merge SQL generator (foundation §3.2.1). The load-bearing assertions:
 *   - class M → GREATEST(target, EXCLUDED)  (no-op on equal retry)
 *   - cat.first_seen → LEAST (DARK-SPOT #2) while count/last_seen → GREATEST
 *   - class N → EXCLUDED WHERE EXCLUDED.gen >= target.gen (GREATEST forbidden)
 *   - class L → EXCLUDED WHERE EXCLUDED.as_of >= target.as_of
 *   - class S → target || EXCLUDED (union, never blind replace)
 */
describe('buildFlushStatement (foundation §3.2.1)', () => {
  describe('class M — monotonic-additive', () => {
    it('EVENT_DAY_COUNT uses GREATEST on count', () => {
      const { sql, params } = buildFlushStatement(INGEST_MERGE_SPECS.eventDayCount, {
        pk: { game_id: 'g1', event_name: 'login', utc_day: '2026-07-18' },
        values: { count: '42' },
      });
      expect(sql).toContain('INSERT INTO "event_day_count"');
      expect(sql).toContain('ON CONFLICT ("game_id", "event_name", "utc_day")');
      expect(sql).toContain('"count" = GREATEST("event_day_count"."count", EXCLUDED."count")');
      expect(sql).not.toContain('WHERE'); // class M needs no guard
      expect(params).toEqual(['g1', 'login', '2026-07-18', '42']);
    });

    it('EXCEPTION_TALLY uses GREATEST on count', () => {
      const { sql } = buildFlushStatement(INGEST_MERGE_SPECS.exceptionTally, {
        pk: { game_id: 'g1', utc_day: '2026-07-18', reason: 'nameless' },
        values: { count: '5' },
      });
      expect(sql).toContain('"count" = GREATEST("exception_tally"."count", EXCLUDED."count")');
    });
  });

  describe('mixed-cat — DARK-SPOT #2', () => {
    it('first_seen uses LEAST while count/last_seen use GREATEST and types UNION', () => {
      const { sql } = buildFlushStatement(INGEST_MERGE_SPECS.eventCatalog, {
        pk: { game_id: 'g1', event_name: 'login' },
        values: {
          lifetime_count: '100',
          last_seen: '2026-07-18T10:00:00Z',
          first_seen: '2026-07-18T09:00:00Z',
          property_type_sets: { level: ['number'] },
        },
      });
      // The one that is easy to reverse (target ref table-qualified — 42702 guard):
      expect(sql).toContain('"first_seen" = LEAST("event_catalog"."first_seen", EXCLUDED."first_seen")');
      // Everything else rises / unions:
      expect(sql).toContain('"lifetime_count" = GREATEST("event_catalog"."lifetime_count", EXCLUDED."lifetime_count")');
      expect(sql).toContain('"last_seen" = GREATEST("event_catalog"."last_seen", EXCLUDED."last_seen")');
      expect(sql).toContain(
        '"property_type_sets" = "event_catalog"."property_type_sets" || EXCLUDED."property_type_sets"',
      );
      // first_seen must NOT be GREATEST:
      expect(sql).not.toContain('"first_seen" = GREATEST');
    });

    it('serialises the jsonb union column as JSON', () => {
      const { params } = buildFlushStatement(INGEST_MERGE_SPECS.eventCatalog, {
        pk: { game_id: 'g1', event_name: 'login' },
        values: {
          lifetime_count: '1',
          last_seen: 't2',
          first_seen: 't1',
          property_type_sets: { level: ['number'] },
        },
      });
      expect(params[params.length - 1]).toBe(JSON.stringify({ level: ['number'] }));
    });
  });

  describe('class N — gen-gated (GREATEST forbidden)', () => {
    const monSpec: MergeTableSpec = {
      table: 'monetization_cell',
      pkColumns: ['game_id', 'utc_day', 'dim_combo'],
      valueColumns: [{ column: 'revenue_normalized', rule: 'gen-gated' }],
      guardColumn: 'gen',
    };
    it('replaces with EXCLUDED under a WHERE EXCLUDED.gen >= target.gen guard', () => {
      const { sql, params } = buildFlushStatement(monSpec, {
        pk: { game_id: 'g1', utc_day: '2026-07-18', dim_combo: 'US:ios' },
        values: { revenue_normalized: '9990' },
        guard: 7,
      });
      expect(sql).toContain('"revenue_normalized" = EXCLUDED."revenue_normalized"');
      expect(sql).toContain('"gen" = EXCLUDED."gen"');
      expect(sql).toContain('WHERE EXCLUDED."gen" >= "monetization_cell"."gen"');
      expect(sql).not.toContain('GREATEST'); // forbidden for class N
      expect(params).toEqual(['g1', '2026-07-18', 'US:ios', '9990', 7]);
    });
  });

  describe('class L — LWW', () => {
    const balSpec: MergeTableSpec = {
      table: 'balance_snapshot',
      pkColumns: ['game_id', 'user_id'],
      valueColumns: [{ column: 'balance', rule: 'lww' }],
      guardColumn: 'as_of',
    };
    it('replaces with EXCLUDED under a WHERE EXCLUDED.as_of >= target.as_of guard', () => {
      const { sql } = buildFlushStatement(balSpec, {
        pk: { game_id: 'g1', user_id: 'u1' },
        values: { balance: '250' },
        guard: '2026-07-18T10:00:00Z',
      });
      expect(sql).toContain('"balance" = EXCLUDED."balance"');
      expect(sql).toContain('WHERE EXCLUDED."as_of" >= "balance_snapshot"."as_of"');
    });
  });

  describe('class S — set-union', () => {
    const setSpec: MergeTableSpec = {
      table: 'active_user_day',
      pkColumns: ['game_id', 'utc_day'],
      valueColumns: [{ column: 'members', rule: 'set-union' }],
    };
    it('unions members, never blind replace', () => {
      const { sql } = buildFlushStatement(setSpec, {
        pk: { game_id: 'g1', utc_day: '2026-07-18' },
        values: { members: ['u1', 'u2'] },
      });
      expect(sql).toContain('"members" = "active_user_day"."members" || EXCLUDED."members"');
    });
  });

  describe('guards', () => {
    it('rejects a gen-gated column with no guardColumn', () => {
      const bad: MergeTableSpec = {
        table: 't',
        pkColumns: ['a'],
        valueColumns: [{ column: 'x', rule: 'gen-gated' }],
      };
      expect(() => buildFlushStatement(bad, { pk: { a: '1' }, values: { x: '1' } })).toThrow(/guardColumn/);
    });
    it('rejects an empty PK', () => {
      const bad: MergeTableSpec = { table: 't', pkColumns: [], valueColumns: [] };
      expect(() => buildFlushStatement(bad, { pk: {}, values: {} })).toThrow(/at least one PK/);
    });
    it('rejects an illegal identifier', () => {
      const bad: MergeTableSpec = {
        table: 'bad table',
        pkColumns: ['a'],
        valueColumns: [],
      };
      expect(() => buildFlushStatement(bad, { pk: { a: '1' }, values: {} })).toThrow(/illegal identifier/);
    });
    it('assertSupportedTaxonomy accepts M/N/S/L/mixed-cat', () => {
      for (const t of ['M', 'N', 'S', 'L', 'mixed-cat'] as const) {
        expect(() => assertSupportedTaxonomy(t)).not.toThrow();
      }
    });
  });
});
