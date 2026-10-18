import type { SQLInputValue } from 'node:sqlite';

/** How a filter column is held in memory. */
export type FilterType = 'float64' | 'float32' | 'int32' | 'int16';

/** One numeric filter column of the application. */
export interface FilterColumn {
  /** Its name, as searches refer to it. */
  name: string;
  /**
   * How it is held: `float32` and `int16` save memory, and the rare rows a rounded value cannot
   * decide (a float32 equal to a rounded bound, an int16 saturated) are tested again on their exact
   * value with the columns SQL.
   * @default 'float64'
   */
  type?: FilterType;
}

/** The order key and the filter columns. */
export interface ColumnsSpec {
  /**
   * A SELECT returning, for the molecules with an id in [:from, :to], ordered by id: the id, the
   * order key, then one value per filter column, in the order of `filters`. A molecule it does not
   * return is never answered. Example:
   * `SELECT m.id, f.mw, m.logP FROM molecules m JOIN formulas f ON f.id = m.formulaId
   * WHERE m.id BETWEEN :from AND :to ORDER BY m.id`.
   */
  sql: string;
  /**
   * The filter columns.
   * @default []
   */
  filters?: FilterColumn[];
}

/** A family of id sets: the sets a search can be restricted to. */
export interface SetFamily {
  /**
   * A SELECT listing the family's sets, one name (text or integer) per row in the first column;
   * read at load and at every poll. Omitted: the family is a single set named after its key.
   */
  names?: string;
  /**
   * A SELECT returning the members of one set with an id in [:from, :to], ordered by id; `:set` is
   * the set's name when the family has `names`.
   */
  members: string;
}

/** The application's change log, which tells the index which molecules to read again. */
export interface ChangeLogSpec {
  /**
   * A SELECT returning (change id, molecule id) rows with a change id above :after, ordered by
   * change id, at most :limit.
   */
  read: string;
  /** A SELECT returning the last change id ever issued (0 or NULL when none). */
  last: string;
  /** A SELECT returning the first change id still in the log (NULL when it is empty). */
  first: string;
}

/** What the application hands the index, as SQL it runs at load and on each change. */
export interface IndexSpec {
  /** The order key and the filter columns. */
  columns: ColumnsSpec;
  /**
   * The id sets, by family. A set is named `family` (a family without names) or `family:name`.
   * @default {}
   */
  sets?: Record<string, SetFamily>;
  /**
   * The sets a search is restricted to when it names none (their union).
   * @default every molecule the columns SQL returns
   */
  defaultSets?: string[];
  /** The change log; without it, changes to molecules already loaded are not followed. */
  changes?: ChangeLogSpec;
}

/** A filter column with its type settled. */
export interface NormalizedFilter {
  name: string;
  type: FilterType;
}

/** A set family with its key. */
export interface NormalizedFamily {
  family: string;
  names: string | null;
  members: string;
}

/** The specification as the index reads it. */
export interface NormalizedSpec {
  columnsSql: string;
  filters: NormalizedFilter[];
  families: NormalizedFamily[];
  defaultSets: string[] | null;
  changes: ChangeLogSpec | null;
}

const TYPES = new Set<FilterType>(['float64', 'float32', 'int32', 'int16']);

/**
 * Checks and completes a specification.
 * @param spec - The application's specification.
 * @returns It, normalized.
 */
export function normalizeSpec(spec: IndexSpec): NormalizedSpec {
  if (typeof spec?.columns?.sql !== 'string') {
    throw new TypeError('spec.columns.sql is required');
  }
  const filters = (spec.columns.filters ?? []).map((filter) => {
    const type = filter.type ?? 'float64';
    if (!TYPES.has(type)) {
      throw new TypeError(`filter ${filter.name}: type ${type}`);
    }
    return { name: filter.name, type };
  });
  const names = new Set(filters.map((filter) => filter.name));
  if (names.size !== filters.length) {
    throw new TypeError('filter names must be distinct');
  }
  const families = Object.entries(spec.sets ?? {}).map(([family, set]) => {
    if (family.includes(':')) {
      throw new TypeError(`set family "${family}": no colon in a family name`);
    }
    return { family, names: set.names ?? null, members: set.members };
  });
  return {
    columnsSql: spec.columns.sql,
    filters,
    families,
    defaultSets: spec.defaultSets ?? null,
    changes: spec.changes ?? null,
  };
}

/**
 * The named parameters of a set's members SQL.
 * @param value - The set's name within its family, null for a family that is one set.
 * @param from - The first id.
 * @param to - The last id.
 * @returns The parameters.
 */
export function memberParameters(
  value: unknown,
  from: number,
  to: number,
): Record<string, SQLInputValue> {
  const parameters: Record<string, SQLInputValue> = { from, to };
  if (value !== null) parameters.set = value as SQLInputValue;
  return parameters;
}

/**
 * The name of a set.
 * @param family - Its family.
 * @param name - Its name within the family, or null for a family that is one set.
 * @returns `family` or `family:name`.
 */
export function setName(family: string, name: unknown): string {
  if (name === null) return family;
  return `${family}:${typeof name === 'string' || typeof name === 'number' || typeof name === 'bigint' ? String(name) : JSON.stringify(name)}`;
}
