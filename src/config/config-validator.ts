/**
 * Config value validator (T-10.24) — validates a candidate value against a knob's
 * registered {@link ValueContract}. Pure + total: returns an `ok` result or a
 * human-readable reason. The config-write path (ConfigAdminService) rejects an
 * out-of-contract value BEFORE any GAME.config write or CONFIG_AUDIT append
 * (T-10.43: no write, no audit on rejection).
 */

import type { ValueContract } from './config-contract';

/** Outcome of validating one value against a contract. */
export type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const OK: ValidationResult = { ok: true };
function fail(reason: string): ValidationResult {
  return { ok: false, reason };
}

/** Validate `value` against `contract`. Total — never throws. */
export function validateValue(contract: ValueContract, value: unknown): ValidationResult {
  switch (contract.type) {
    case 'int':
      return validateInt(contract, value);
    case 'number':
      return validateNumber(contract, value);
    case 'boolean':
      return typeof value === 'boolean' ? OK : fail('expected a boolean');
    case 'string':
      return validateString(contract, value);
    case 'enum':
      return typeof value === 'string' && contract.values.includes(value)
        ? OK
        : fail(`expected one of: ${contract.values.join(', ')}`);
    case 'array':
      return validateArray(contract, value);
    case 'object':
      return isPlainObject(value) ? OK : fail('expected a JSON object');
    default:
      // Exhaustiveness guard — a new contract kind must be handled above.
      return assertNever(contract);
  }
}

function validateInt(contract: Extract<ValueContract, { type: 'int' }>, value: unknown): ValidationResult {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fail('expected an integer');
  }
  return checkRange(value, contract.min, contract.max);
}

function validateNumber(contract: Extract<ValueContract, { type: 'number' }>, value: unknown): ValidationResult {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('expected a finite number');
  }
  return checkRange(value, contract.min, contract.max);
}

function checkRange(value: number, min?: number, max?: number): ValidationResult {
  if (min !== undefined && value < min) {
    return fail(`must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    return fail(`must be <= ${max}`);
  }
  return OK;
}

function validateString(contract: Extract<ValueContract, { type: 'string' }>, value: unknown): ValidationResult {
  if (typeof value !== 'string') {
    return fail('expected a string');
  }
  if (contract.maxLength !== undefined && value.length > contract.maxLength) {
    return fail(`must be at most ${contract.maxLength} characters`);
  }
  return OK;
}

function validateArray(contract: Extract<ValueContract, { type: 'array' }>, value: unknown): ValidationResult {
  if (!Array.isArray(value)) {
    return fail('expected an array');
  }
  if (contract.maxItems !== undefined && value.length > contract.maxItems) {
    return fail(`must have at most ${contract.maxItems} items`);
  }
  for (let i = 0; i < value.length; i += 1) {
    const elem = validateValue(contract.element, value[i]);
    if (!elem.ok) {
      return fail(`element ${i}: ${elem.reason}`);
    }
  }
  return OK;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNever(x: never): never {
  throw new Error(`[config-validator] unhandled contract kind: ${JSON.stringify(x)}`);
}
