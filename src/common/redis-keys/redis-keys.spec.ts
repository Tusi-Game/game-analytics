import { ALL_DOMAINS, dayLessKey, dayScopedKey, IngestKeys, isDomain, OWNED_DOMAINS_002 } from './redis-keys';

describe('redis key grammar (foundation §2.1)', () => {
  describe('day-scoped keys', () => {
    it('builds {game_id}:{domain}:{utc_day}', () => {
      expect(dayScopedKey('game-42', 'cnt', '2026-07-18')).toBe('game-42:cnt:2026-07-18');
    });

    it('appends qualifiers in order', () => {
      expect(dayScopedKey('g', 'cnt', '2026-07-18', 'exc')).toBe('g:cnt:2026-07-18:exc');
      expect(dayScopedKey('g', 'cnt', '2026-07-18', 'rank')).toBe('g:cnt:2026-07-18:rank');
    });
  });

  describe('day-less keys', () => {
    it('builds {game_id}:{domain}[:{qual}]', () => {
      expect(dayLessKey('game-42', 'dedup', 'evt-1')).toBe('game-42:dedup:evt-1');
      expect(dayLessKey('game-42', 'cat', 'names')).toBe('game-42:cat:names');
    });
  });

  describe('domain registry / collision guard', () => {
    it('accepts every registered palette domain', () => {
      for (const d of ALL_DOMAINS) {
        expect(isDomain(d)).toBe(true);
        expect(() => dayLessKey('g', d)).not.toThrow();
      }
    });

    it('reserves the full cross-story palette + ops/panel', () => {
      // 002-owned
      for (const d of ['cnt', 'cat', 'dedup']) expect(isDomain(d)).toBe(true);
      // reserved story domains
      for (const d of ['sess', 'act', 'eco', 'bal', 'ret', 'mon', 'payer', 'rev', 'stage']) {
        expect(isDomain(d)).toBe(true);
      }
      // ops/panel namespace
      for (const d of ['ops', 'panel']) expect(isDomain(d)).toBe(true);
    });

    it('rejects an unregistered domain tag (collision guard)', () => {
      expect(isDomain('bogus')).toBe(false);
      expect(() => dayScopedKey('g', 'bogus', '2026-07-18')).toThrow(/unknown domain/);
      expect(() => dayLessKey('g', 'nope')).toThrow(/unknown domain/);
    });

    it('exposes the 002-owned domains', () => {
      expect([...OWNED_DOMAINS_002]).toEqual(['cnt', 'cat', 'dedup']);
    });
  });

  describe('segment validation', () => {
    it('rejects a segment containing the separator', () => {
      expect(() => dayScopedKey('game:evil', 'cnt', '2026-07-18')).toThrow(/must not contain ':'/);
      expect(() => dayLessKey('g', 'dedup', 'evt:1')).toThrow(/must not contain ':'/);
    });

    it('rejects an empty segment', () => {
      expect(() => dayScopedKey('', 'cnt', '2026-07-18')).toThrow(/non-empty/);
      expect(() => dayLessKey('g', 'dedup', '')).toThrow(/non-empty/);
    });
  });

  describe('named ingest key builders', () => {
    it('produces the canonical 002 spellings', () => {
      expect(IngestKeys.dedup('game-42', 'evt-1')).toBe('game-42:dedup:evt-1');
      expect(IngestKeys.cnt('game-42', '2026-07-18')).toBe('game-42:cnt:2026-07-18');
      expect(IngestKeys.cntExc('game-42', '2026-07-18')).toBe('game-42:cnt:2026-07-18:exc');
      expect(IngestKeys.cntRank('game-42', '2026-07-18')).toBe('game-42:cnt:2026-07-18:rank');
      expect(IngestKeys.cat('game-42', 'level_up')).toBe('game-42:cat:level_up');
      expect(IngestKeys.catNames('game-42')).toBe('game-42:cat:names');
    });
  });
});
