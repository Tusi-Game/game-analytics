import { validateValue } from './config-validator';
import type { ValueContract } from './config-contract';

/**
 * Config value validator (T-10.24/43) — the pure guard the write path uses to
 * reject out-of-contract values BEFORE any write or audit.
 */
describe('validateValue', () => {
  it('int: accepts in-range integers, rejects non-ints and out-of-range', () => {
    const c: ValueContract = { type: 'int', min: 1, max: 10 };
    expect(validateValue(c, 5).ok).toBe(true);
    expect(validateValue(c, 1).ok).toBe(true);
    expect(validateValue(c, 10).ok).toBe(true);
    expect(validateValue(c, 0).ok).toBe(false); // below min
    expect(validateValue(c, 11).ok).toBe(false); // above max
    expect(validateValue(c, 3.5).ok).toBe(false); // not an integer
    expect(validateValue(c, '5').ok).toBe(false); // wrong type
    expect(validateValue(c, true).ok).toBe(false);
  });

  it('number: accepts finite numbers, rejects NaN/Infinity/strings', () => {
    const c: ValueContract = { type: 'number', min: 0, max: 1 };
    expect(validateValue(c, 0.5).ok).toBe(true);
    expect(validateValue(c, Number.NaN).ok).toBe(false);
    expect(validateValue(c, Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validateValue(c, 2).ok).toBe(false);
  });

  it('boolean: only accepts booleans', () => {
    const c: ValueContract = { type: 'boolean' };
    expect(validateValue(c, true).ok).toBe(true);
    expect(validateValue(c, false).ok).toBe(true);
    expect(validateValue(c, 'true').ok).toBe(false);
    expect(validateValue(c, 1).ok).toBe(false);
  });

  it('enum: only accepts a value in the closed set', () => {
    const c: ValueContract = { type: 'enum', values: ['detach', 'delete'] };
    expect(validateValue(c, 'detach').ok).toBe(true);
    expect(validateValue(c, 'delete').ok).toBe(true);
    expect(validateValue(c, 'nuke').ok).toBe(false);
    expect(validateValue(c, 42).ok).toBe(false);
  });

  it('string: enforces maxLength', () => {
    const c: ValueContract = { type: 'string', maxLength: 4 };
    expect(validateValue(c, 'abcd').ok).toBe(true);
    expect(validateValue(c, 'abcde').ok).toBe(false);
    expect(validateValue(c, 123).ok).toBe(false);
  });

  it('array: validates each element + maxItems', () => {
    const c: ValueContract = { type: 'array', element: { type: 'string', maxLength: 8 }, maxItems: 3 };
    expect(validateValue(c, ['a', 'b']).ok).toBe(true);
    expect(validateValue(c, ['a', 'b', 'c', 'd']).ok).toBe(false); // too many
    expect(validateValue(c, ['a', 123]).ok).toBe(false); // bad element
    expect(validateValue(c, 'notarray').ok).toBe(false);
  });

  it('object: accepts a plain JSON object, rejects arrays/null/primitives', () => {
    const c: ValueContract = { type: 'object' };
    expect(validateValue(c, { a: 1 }).ok).toBe(true);
    expect(validateValue(c, {}).ok).toBe(true);
    expect(validateValue(c, []).ok).toBe(false);
    expect(validateValue(c, null).ok).toBe(false);
    expect(validateValue(c, 'x').ok).toBe(false);
  });

  it('returns a human-readable reason on failure', () => {
    const r = validateValue({ type: 'int', min: 1, max: 10 }, 99);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/<= 10/);
    }
  });
});
