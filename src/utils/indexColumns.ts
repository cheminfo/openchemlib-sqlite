import type {
  ColumnRange,
  ColumnStatus,
  IndexColumnType,
  SQLiteDatabase,
} from '../types.ts';

/** Table recording the columns `ocl_ss_index` carries and how far each is filled. */
export const COLUMNS_TABLE = 'ocl_ss_columns';

/** What a caller column is called in `ocl_ss_index`, ahead of its own name. */
const CALLER_PREFIX = 'col_';

/** A caller's name for a column: a plain identifier. */
const COLUMN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

/**
 * SQL creating the table that records the carried columns.
 *
 * - `name`: the column of `ocl_ss_index`, `col_<caller's name>`.
 * - `type`: `integer` or `real`.
 * - `fill_to`, `fill_cursor`: a column added to an index that already held
 *   entries is NULL for every one of them, and filling them is a job of its
 *   own — see `fillColumns()`. `fill_to` is the highest entry id the column
 *   was added over, `fill_cursor` the last one filled; `fill_to` is NULL once
 *   every entry carries a value, and only then may a search bound the column.
 * @returns SQL ready for db.exec().
 */
export function buildColumnsTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${COLUMNS_TABLE} (
  name        TEXT    PRIMARY KEY,
  type        TEXT    NOT NULL,
  fill_to     INTEGER,
  fill_cursor INTEGER NOT NULL DEFAULT 0
);`;
}

/**
 * The column of `ocl_ss_index` holding a caller's column.
 * @param name - The caller's name for it.
 * @returns The SQL name.
 * @throws {Error} When the name is not a plain identifier.
 */
export function columnSqlName(name: string): string {
  if (!COLUMN_NAME.test(name)) {
    throw new Error(
      `the column name "${name}" is not a plain identifier of at most 60 characters`,
    );
  }
  return `${CALLER_PREFIX}${name}`;
}

/**
 * Give `ocl_ss_index` the columns it is declared to carry, and record them.
 *
 * Adding a column is a change to the schema alone — SQLite rewrites no row —
 * so this is instant whatever the size of the index. A column added to an
 * index that already holds entries is NULL for each of them until
 * `fillColumns()` has reached it, and a search may not bound it before then:
 * a NULL would quietly drop the entry. An index with no entry yet is complete
 * from the start.
 *
 * A column is never dropped or retyped here. One no longer declared stays, is
 * no longer written and may no longer be bounded; one declared with another
 * type is refused, because its values would mean something else.
 * @param db - The database to change.
 * @param declared - The columns, by SQL name, and their types.
 * @throws {Error} When a column already exists with another type.
 */
export function reconcileColumns(
  db: SQLiteDatabase,
  declared: ReadonlyMap<string, IndexColumnType>,
): void {
  db.exec(buildColumnsTableSql());
  const present = new Set(
    (
      db
        .prepare(`SELECT name FROM pragma_table_info('ocl_ss_index')`)
        .all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  const recorded = new Map(
    (
      db.prepare(`SELECT name, type FROM ${COLUMNS_TABLE}`).all() as Array<{
        name: string;
        type: string;
      }>
    ).map((row) => [row.name, row.type]),
  );
  const highest = db
    .prepare('SELECT MAX(entry_id) AS id FROM ocl_ss_index')
    .get() as { id: number | null } | undefined;
  const fillTo = highest?.id ?? null;

  for (const [name, type] of declared) {
    const known = recorded.get(name);
    if (known !== undefined && known !== type) {
      throw new Error(
        `ocl_ss_index carries ${name} as ${known}; it cannot be declared ${type}`,
      );
    }
    if (!present.has(name)) {
      db.exec(
        `ALTER TABLE ocl_ss_index ADD COLUMN ${name} ${type === 'integer' ? 'INTEGER' : 'REAL'}`,
      );
    }
    if (known === undefined) {
      // A column already there without a record was added by hand, or by a
      // run that stopped before recording it: its values cannot be vouched
      // for, so it is filled again like a new one.
      db.prepare(
        `INSERT INTO ${COLUMNS_TABLE} (name, type, fill_to) VALUES (?, ?, ?)`,
      ).run(name, type, fillTo);
    }
  }
}

/**
 * Every carried column, and how far it is filled.
 * @param db - The database to read.
 * @param declared - The columns this instance declares, by SQL name.
 * @returns The columns, by name.
 */
export function columnStatusOf(
  db: SQLiteDatabase,
  declared: ReadonlyMap<string, IndexColumnType>,
): ColumnStatus[] {
  if (!hasColumnsTable(db)) return [];
  const rows = db
    .prepare(
      `SELECT name, type, fill_to, fill_cursor FROM ${COLUMNS_TABLE} ORDER BY name`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const name = String(row.name);
    const fillTo = row.fill_to == null ? null : Number(row.fill_to);
    return {
      name: callerName(name),
      type: row.type as IndexColumnType,
      declared: declared.has(name),
      complete: fillTo === null,
      ...(fillTo === null
        ? {}
        : { filledThrough: Number(row.fill_cursor), fillTo }),
    };
  });
}

/**
 * The columns a search may bound: declared by this instance, and filled for
 * every entry.
 * @param db - The database to read.
 * @param declared - The columns this instance declares, by SQL name.
 * @returns Their SQL names.
 */
export function boundableColumns(
  db: SQLiteDatabase,
  declared: ReadonlyMap<string, IndexColumnType>,
): Set<string> {
  const usable = new Set<string>();
  if (!hasColumnsTable(db)) return usable;
  const rows = db
    .prepare(`SELECT name FROM ${COLUMNS_TABLE} WHERE fill_to IS NULL`)
    .all() as Array<{ name: string }>;
  for (const { name } of rows) {
    if (declared.has(name)) usable.add(name);
  }
  return usable;
}

/**
 * The caller's name for a column of `ocl_ss_index`.
 * @param sqlName - The column's SQL name.
 * @returns The name the caller declared.
 */
export function callerName(sqlName: string): string {
  return sqlName.startsWith(CALLER_PREFIX)
    ? sqlName.slice(CALLER_PREFIX.length)
    : sqlName;
}

/** Bounds on carried columns, as SQL conditions on `s` and their values. */
export interface ColumnConditions {
  /** The conditions, each one a comparison. */
  conditions: string[];
  /** Their values, in order. */
  values: number[];
}

/**
 * Turn a search's bounds on carried columns into conditions on `s`.
 * @param ranges - The bounds, by the caller's names.
 * @param usable - The SQL names a search may bound, from {@link boundableColumns}.
 * @returns The conditions.
 * @throws {Error} When a bound names a column the index does not carry in full.
 */
export function columnConditions(
  ranges: Readonly<Record<string, ColumnRange>> | undefined,
  usable: ReadonlySet<string>,
): ColumnConditions {
  const conditions: string[] = [];
  const values: number[] = [];
  for (const [name, range] of Object.entries(ranges ?? {})) {
    const column = columnSqlName(name);
    if (!usable.has(column)) {
      throw new Error(
        `the index does not carry the column "${name}" for every entry; see columnStatus()`,
      );
    }
    if (range.min !== undefined) {
      conditions.push(`s.${column} >= ?`);
      values.push(range.min);
    }
    if (range.max !== undefined) {
      conditions.push(`s.${column} <= ?`);
      values.push(range.max);
    }
  }
  return { conditions, values };
}

/**
 * Whether the database records its carried columns: a file migrated before
 * they existed, opened by a reader that does not migrate, has no such table.
 * @param db - The database to read.
 * @returns True when the table is there.
 */
function hasColumnsTable(db: SQLiteDatabase): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`)
      .get(COLUMNS_TABLE) !== undefined
  );
}
