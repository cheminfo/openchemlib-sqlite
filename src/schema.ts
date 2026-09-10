export interface SchemaConfig {
  entriesTable: string;
  pkColumn: string;
}

/** Table recording which schema version this database is at. */
export const VERSION_TABLE = 'ocl_ss_schema';

/**
 * SQL creating the version table. It is what makes the schema upgradable: once a
 * database records its version, every later release can tell exactly which
 * migrations it still owes, instead of guessing from the table's shape.
 * @returns SQL ready for db.exec().
 */
export function buildVersionTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${VERSION_TABLE} (
  version    INTEGER NOT NULL,
  applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
);`;
}

/**
 * Version 1: the original fingerprint table, keyed by entry_id.
 *
 * Kept verbatim although no release creates it any more: migrations replay from
 * whatever version a database is at, so a fresh database walks 0 -> 1 -> 2 like
 * every other. Never edit a shipped migration — add a new one.
 * @param config - Entries table name and primary key column name.
 * @returns SQL ready for db.exec().
 */
export function buildSchemaSqlV1(config: SchemaConfig): string {
  return `
CREATE TABLE IF NOT EXISTS ocl_ss_index (
  entry_id  INTEGER PRIMARY KEY REFERENCES ${config.entriesTable}(${config.pkColumn}),
  ss_index0 INTEGER NOT NULL DEFAULT 0,
  ss_index1 INTEGER NOT NULL DEFAULT 0,
  ss_index2 INTEGER NOT NULL DEFAULT 0,
  ss_index3 INTEGER NOT NULL DEFAULT 0,
  ss_index4 INTEGER NOT NULL DEFAULT 0,
  ss_index5 INTEGER NOT NULL DEFAULT 0,
  ss_index6 INTEGER NOT NULL DEFAULT 0,
  ss_index7 INTEGER NOT NULL DEFAULT 0
);
`;
}

/**
 * Build SQL creating the current ocl_ss_index table under the given name.
 *
 * The table is **clustered by molecular weight**: it is `WITHOUT ROWID` with
 * primary key `(mw, entry_id)`, so its rows are physically stored in ascending
 * `mw` order. A substructure prescreen that scans the table therefore visits the
 * lightest molecules first and, when it stops early at `maxResults`, keeps the
 * smallest superstructures — the matches closest to the query. A secondary
 * unique index on `entry_id` supports existence checks and the join back to the
 * entries table (since `entry_id` is no longer the rowid/PK alias).
 * @param config - Entries table name and primary key column name.
 * @param table - Table to create. A migration builds the new table under a
 *   temporary name before swapping it in, so this is not always ocl_ss_index.
 * @returns SQL ready for db.exec().
 */
export function buildSchemaSqlV2(
  config: SchemaConfig,
  table = 'ocl_ss_index',
): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  mw        REAL    NOT NULL,
  entry_id  INTEGER NOT NULL REFERENCES ${config.entriesTable}(${config.pkColumn}),
  ss_index0 INTEGER NOT NULL DEFAULT 0,
  ss_index1 INTEGER NOT NULL DEFAULT 0,
  ss_index2 INTEGER NOT NULL DEFAULT 0,
  ss_index3 INTEGER NOT NULL DEFAULT 0,
  ss_index4 INTEGER NOT NULL DEFAULT 0,
  ss_index5 INTEGER NOT NULL DEFAULT 0,
  ss_index6 INTEGER NOT NULL DEFAULT 0,
  ss_index7 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mw, entry_id)
) WITHOUT ROWID;
`;
}

/**
 * SQL creating the secondary index on entry_id for the current schema.
 * @param table - Table the index is built on.
 * @param name - Index name.
 * @returns SQL ready for db.exec().
 */
export function buildEntryIndexSql(
  table = 'ocl_ss_index',
  name = 'idx_ocl_ss_entry',
): string {
  return `CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table} (entry_id);`;
}

/** Table holding each entry's no-stereo hash. */
export const NO_STEREO_HASH_TABLE = 'ocl_no_stereo_hash';

/** Table holding each entry's no-stereo tautomer hash. */
export const NO_STEREO_TAUTOMER_HASH_TABLE = 'ocl_no_stereo_tautomer_hash';

/**
 * Build one of the two structure-hash tables. Both have the same shape.
 *
 * A row's **presence** is what records that an entry has been hashed, which is
 * what makes a backfill resumable: `hash IS NULL` means OpenChemLib produced no
 * hash for that molecule — it would not parse, could not be canonized, or ran
 * past the cap — while *no row at all* means it has not been tried yet. Storing
 * the two states in one nullable column would make them indistinguishable, and
 * a resumed backfill would either redo the give-ups forever or skip entries it
 * never actually hashed.
 *
 * The two hashes get a table each rather than two columns of one, because they
 * are filled by separate passes: the no-stereo hash costs ~74 µs and the
 * no-stereo tautomer hash averages ~22 ms, so the cheap one runs to completion
 * first and its table is complete while the expensive one is still filling.
 * Sharing a table would need a second "attempted" marker per hash to say the
 * same thing a row's presence already says.
 *
 * The hash is OpenChemLib's own — `CanonizerUtil.getNoStereoHash` or
 * `getNoStereoTautomerHash` — a signed 64-bit integer, which is exactly what an
 * SQLite INTEGER column stores and indexes, so nothing is converted either way.
 * @param config - Entries table name and primary key column name.
 * @param table - Which hash table to create.
 * @returns SQL ready for db.exec().
 */
export function buildHashTableSql(config: SchemaConfig, table: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  entry_id INTEGER PRIMARY KEY REFERENCES ${config.entriesTable}(${config.pkColumn}),
  hash     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_${table} ON ${table} (hash) WHERE hash IS NOT NULL;
`;
}
