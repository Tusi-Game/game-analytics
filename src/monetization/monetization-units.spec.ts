/**
 * Pure-logic unit tests for 006-monetization + 007-derived-kpis (no infra):
 *   - dim_combo canonical encoding (lexicographic order stable across config reorder;
 *     unknown/other first-class; sanitize round-trip);
 *   - cell-key encode/parse; loc-field parse;
 *   - FX mulDecimal 3-way arithmetic;
 *   - payer-tier classification (first / repeat tiers / indeterminate abstention);
 *   - whale-concentration hand-computed shares.
 */

import {
  buildDimCombo,
  parseDimCombo,
  dimComboHas,
  sanitizeValue,
  unsanitizeValue,
  computeLevelBucket,
  UNKNOWN_VALUE,
  OTHER_VALUE,
} from './dim-combo';
import { cellKey, parseCellKey, locField, parseLocField } from './mon-keys';
import { mulDecimal } from './fx.service';
import { classifyTier } from './purchase-durable.hook';
import { periodOfDay } from './monetization-config.service';

describe('dim-combo canonical encoding', () => {
  it('orders components lexicographically by dimension NAME, not config order', () => {
    // Same values, two different config declaration orders → identical dim_combo.
    const a = buildDimCombo(['region', 'in_game_state'], { region: 'EU', in_game_state: 'out_of_energy' });
    const b = buildDimCombo(['in_game_state', 'region'], { in_game_state: 'out_of_energy', region: 'EU' });
    expect(a).toBe(b);
    expect(a).toBe('in_game_state=out_of_energy|region=EU');
  });

  it('renders an absent value as the literal unknown, never omitted', () => {
    const combo = buildDimCombo(['region', 'payer_tier'], { payer_tier: 'first' });
    expect(combo).toBe(`payer_tier=first|region=${UNKNOWN_VALUE}`);
    expect(parseDimCombo(combo).region).toBe('unknown');
  });

  it('keeps other distinct from unknown', () => {
    const combo = buildDimCombo(['region'], { region: OTHER_VALUE });
    expect(combo).toBe('region=other');
    expect(parseDimCombo(combo).region).toBe('other');
  });

  it('sanitizes + round-trips values containing the | and = delimiters', () => {
    const raw = 'a|b=c';
    const escaped = sanitizeValue(raw);
    expect(unsanitizeValue(escaped)).toBe(raw);
    const combo = buildDimCombo(['region'], { region: raw });
    // The value must not forge a second component.
    expect(parseDimCombo(combo).region).toBe(raw);
    expect(Object.keys(parseDimCombo(combo))).toEqual(['region']);
  });

  it('dimComboHas detects a D= component', () => {
    const combo = buildDimCombo(['region', 'in_game_state'], { region: 'EU', in_game_state: 'pre_boss' });
    expect(dimComboHas(combo, 'region')).toBe(true);
    expect(dimComboHas(combo, 'payer_tier')).toBe(false);
  });

  it('level bucket labels', () => {
    const b = [10, 20, 30, 40, 50];
    expect(computeLevelBucket(5, b)).toBe('<10');
    expect(computeLevelBucket(12, b)).toBe('10-19');
    expect(computeLevelBucket(55, b)).toBe('50+');
    expect(computeLevelBucket(undefined, b)).toBeNull();
  });
});

describe('mon cell-key + loc-field encoding', () => {
  it('encodes {product}#{dim_combo} and parses back', () => {
    const combo = buildDimCombo(['region'], { region: 'EU' });
    const key = cellKey('energy_pack', combo);
    const parsed = parseCellKey(key);
    expect(parsed).toEqual({ productId: 'energy_pack', dimCombo: combo });
  });

  it('sanitizes a product id containing #', () => {
    const key = cellKey('a#b', 'region=EU');
    const parsed = parseCellKey(key);
    expect(parsed?.productId).toBe('a#b');
    expect(parsed?.dimCombo).toBe('region=EU');
  });

  it('parses a loc field {cell}#{currency} on the last #', () => {
    const cell = cellKey('energy_pack', 'region=EU');
    const field = locField(cell, 'USD');
    const parsed = parseLocField(field);
    expect(parsed?.currency).toBe('USD');
    expect(parsed?.cellKey).toBe(cell);
  });
});

describe('FX mulDecimal (3-way arithmetic)', () => {
  it('fresh conversion local × rate', () => {
    // T2: 0.90 EUR × 1.10 = 0.99 USD (spec worked example).
    expect(mulDecimal('0.90', '1.10')).toBe('0.990000');
  });
  it('IRR micro-rate', () => {
    // 100000 IRR × 0.0000230 = 2.30.
    expect(mulDecimal('100000', '0.0000230')).toBe('2.300000');
  });
  it('non-finite → 0', () => {
    expect(mulDecimal('abc', '1.1')).toBe('0');
  });
});

describe('payer-tier classification (bridge 05.5 §6)', () => {
  const rule = { dolphin_min: 10, whale_min: 100 };
  it('no prior row → first (never repeat)', () => {
    expect(classifyTier(false, 0, false, rule)).toBe('first');
  });
  it('repeat purchaser under dolphin_min → minnow', () => {
    expect(classifyTier(true, 4.99, false, rule)).toBe('minnow');
  });
  it('lifetime in [dolphin_min, whale_min) → dolphin', () => {
    expect(classifyTier(true, 50, false, rule)).toBe('dolphin');
  });
  it('lifetime ≥ whale_min → whale', () => {
    expect(classifyTier(true, 150, false, rule)).toBe('whale');
  });
  it('outstanding parked spend → indeterminate (never a deflated minnow)', () => {
    // A real whale whose spend is parked reads indeterminate, not minnow.
    expect(classifyTier(true, 5, true, rule)).toBe('indeterminate');
  });
});

describe('whale concentration (hand-computed)', () => {
  // [500,200,120,80,40,30,15,10,3,2], Revenue = 1000 (spec worked example).
  const spends = [500, 200, 120, 80, 40, 30, 15, 10, 3, 2].sort((a, b) => b - a);
  const revenue = spends.reduce((s, v) => s + v, 0);
  const share = (percent: number): number => {
    const k = Math.ceil((percent / 100) * spends.length);
    return spends.slice(0, k).reduce((s, v) => s + v, 0) / revenue;
  };
  it('top 10% = 50%', () => expect(share(10)).toBeCloseTo(0.5, 6));
  it('top 20% = 70%', () => expect(share(20)).toBeCloseTo(0.7, 6));
  it('top 50% = 94%', () => expect(share(50)).toBeCloseTo(0.94, 6));
});

describe('period-of-day', () => {
  it('YYYY-MM-DD → YYYY-MM', () => {
    expect(periodOfDay('2026-07-18')).toBe('2026-07');
  });
});
