import type { SchemaConfig } from '../schema.ts';
import { referencesEntries } from '../schema.ts';

/** Table holding the transposed fingerprint: one row per (chunk, bit). */
export const PLANE_TABLE = 'ocl_ss_plane';

/** Table mapping a plane slot back to the entry it stands for. */
export const SLOT_TABLE = 'ocl_ss_slot';

/** Table recording how many entries set each of the 512 bits. */
export const BITSTAT_TABLE = 'ocl_ss_bitstat';

/** Table recording each fold's slot range and whether it is mw-ordered. */
export const SEGMENT_TABLE = 'ocl_ss_segment';

/** Table holding fingerprints inserted since the last fold. */
export const TAIL_TABLE = 'ocl_ss_tail';

/** Trigger keeping {@link TAIL_TABLE} filled without `insert()` knowing. */
export const TAIL_TRIGGER = 'ocl_ss_tail_insert';

/**
 * SQL creating every table the plane index needs.
 *
 * `ocl_ss_plane` is clustered **chunk-major** — `PRIMARY KEY (chunk, bit)` —
 * because a query reads the planes of one chunk together before moving on, so
 * chunk-major order makes those reads physically adjacent. Keyed the other way
 * round each chunk's planes would be scattered one stride apart across the whole
 * table, which is the same number of bytes read as many more seeks.
 *
 * A missing `(chunk, bit)` row means that chunk sets the bit for no entry at
 * all. Rare bits therefore cost nothing, which is what keeps the index far
 * smaller than the 64 bytes per molecule its dense form would need.
 * @param config - Entries table name and primary key column name.
 * @returns SQL ready for db.exec().
 */
export function buildPlaneSchemaSql(config: SchemaConfig): string {
  return `
CREATE TABLE IF NOT EXISTS ${PLANE_TABLE} (
  chunk INTEGER NOT NULL,
  bit   INTEGER NOT NULL,
  bits  BLOB    NOT NULL,
  PRIMARY KEY (chunk, bit)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ${SLOT_TABLE} (
  slot     INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL${referencesEntries(config)}
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_${SLOT_TABLE}_entry
  ON ${SLOT_TABLE} (entry_id);

CREATE TABLE IF NOT EXISTS ${BITSTAT_TABLE} (
  bit        INTEGER PRIMARY KEY,
  population INTEGER NOT NULL DEFAULT 0,
  stored     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ${SEGMENT_TABLE} (
  segment     INTEGER PRIMARY KEY,
  first_slot  INTEGER NOT NULL,
  slot_count  INTEGER NOT NULL,
  mw_ordered  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ${TAIL_TABLE} (
  mw        REAL    NOT NULL,
  entry_id  INTEGER NOT NULL,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_${TAIL_TABLE}_entry
  ON ${TAIL_TABLE} (entry_id);

${buildTailTriggerSql()}
`;
}

/**
 * SQL creating the trigger that copies every new fingerprint into the tail.
 *
 * A trigger rather than a line in `insert()`: the tail is an implementation
 * detail of the plane index, and a database that upgrades gains it the moment
 * the migration runs, with no change to how callers insert and no chance of an
 * insert path that forgets. Deleting from the tail — which only the fold does —
 * fires nothing, so folding does not put rows back.
 * @returns SQL ready for db.exec().
 */
export function buildTailTriggerSql(): string {
  return `CREATE TRIGGER IF NOT EXISTS ${TAIL_TRIGGER}
AFTER INSERT ON ocl_ss_index
BEGIN
  INSERT OR REPLACE INTO ${TAIL_TABLE}
    (mw, entry_id, ss_index0, ss_index1, ss_index2, ss_index3,
     ss_index4, ss_index5, ss_index6, ss_index7)
  VALUES
    (NEW.mw, NEW.entry_id, NEW.ss_index0, NEW.ss_index1, NEW.ss_index2,
     NEW.ss_index3, NEW.ss_index4, NEW.ss_index5, NEW.ss_index6,
     NEW.ss_index7);
END;`;
}
