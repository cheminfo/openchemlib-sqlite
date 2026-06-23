interface SchemaConfig {
  entriesTable: string;
  pkColumn: string;
}

/**
 * Build SQL that creates the ocl_ss_index table, referencing the given
 * entries table's primary key. The fingerprint is packed as eight signed
 * 64-bit integers (a BigInt64Array view over a Uint32Array(16) buffer).
 *
 * The table is **clustered by molecular weight**: it is `WITHOUT ROWID` with
 * primary key `(mw, entry_id)`, so its rows are physically stored in ascending
 * `mw` order. A substructure prescreen that scans the table therefore visits the
 * lightest molecules first and, when it stops early at `maxResults`, keeps the
 * smallest superstructures — the matches closest to the query. A secondary
 * unique index on `entry_id` supports existence checks and the join back to the
 * entries table (since `entry_id` is no longer the rowid/PK alias).
 * @param config - Entries table name and primary key column name.
 * @returns SQL string ready for db.exec().
 */
export function buildSchemaSql(config: SchemaConfig): string {
  return `
CREATE TABLE IF NOT EXISTS ocl_ss_index (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_ocl_ss_entry ON ocl_ss_index (entry_id);
`;
}
