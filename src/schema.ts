interface SchemaConfig {
  entriesTable: string;
  pkColumn: string;
}

/**
 * Build SQL that creates the ocl_ss_index table, referencing the given
 * entries table's primary key. The fingerprint is packed as eight signed
 * 64-bit integers (a BigInt64Array view over a Uint32Array(16) buffer).
 * @param config - Entries table name and primary key column name.
 * @returns SQL string ready for db.exec().
 */
export function buildSchemaSql(config: SchemaConfig): string {
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
