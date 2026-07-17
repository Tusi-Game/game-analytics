import { DefaultNamingStrategy, NamingStrategyInterface, Table } from 'typeorm';

function toSnakeCase(input: string): string {
  return input
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Enforces the platform DB column convention (design §5 / FR-004): snake_case
 * table and column names, regardless of the camelCase used in TypeScript entity
 * properties. Entities are added by later stories — this strategy is wired now
 * so every future entity gets snake_case columns without per-entity `@Column`
 * name overrides. PK/FK types (BIGINT) and explicit `@JoinColumn` names remain
 * the entity author's responsibility per the convention.
 */
export class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
  override tableName(className: string, customName: string | undefined): string {
    return customName ? customName : toSnakeCase(className);
  }

  override columnName(propertyName: string, customName: string | undefined, embeddedPrefixes: string[]): string {
    const prefix = embeddedPrefixes.map(toSnakeCase).join('_');
    const base = customName ? customName : toSnakeCase(propertyName);
    return prefix ? `${prefix}_${base}` : base;
  }

  override relationName(propertyName: string): string {
    return toSnakeCase(propertyName);
  }

  override joinColumnName(relationName: string, referencedColumnName: string): string {
    return toSnakeCase(`${relationName}_${referencedColumnName}`);
  }

  override joinTableName(
    firstTableName: string,
    secondTableName: string,
    firstPropertyName: string,
    _secondPropertyName: string,
  ): string {
    return toSnakeCase(`${firstTableName}_${firstPropertyName.replace(/\./gi, '_')}_${secondTableName}`);
  }

  override joinTableColumnName(tableName: string, propertyName: string, columnName?: string): string {
    return toSnakeCase(`${tableName}_${columnName ?? propertyName}`);
  }

  classTableInheritanceParentColumnName(parentTableName: unknown, parentTableIdPropertyName: unknown): string {
    return toSnakeCase(`${parentTableName}_${parentTableIdPropertyName}`);
  }

  eagerJoinRelationAlias(alias: string, propertyPath: string): string {
    return `${alias}__${propertyPath.replace('.', '_')}`;
  }

  override primaryKeyName(tableOrName: Table | string, columnNames: string[]): string {
    const table = typeof tableOrName === 'string' ? tableOrName : tableOrName.name;
    return `pk_${table}_${columnNames.join('_')}`;
  }
}
