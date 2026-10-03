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

/** Trigger taking an entry's row out of {@link TAIL_TABLE} when it is deleted. */
export const TAIL_DELETE_TRIGGER = 'ocl_ss_tail_delete';

/** Single-row table recording how far the folds have reached. */
export const FOLD_TABLE = 'ocl_ss_fold';

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

${buildTailTableSql()}

${buildTailTriggerSqlV5()}
`;
}

/**
 * SQL creating the tail: the fingerprints waiting for a fold that the fold
 * cannot find above its watermark, in the same shape as `ocl_ss_index` so both
 * are screened with the same SQL.
 * @returns SQL ready for db.exec().
 */
export function buildTailTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${TAIL_TABLE} (
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
  ON ${TAIL_TABLE} (entry_id);`;
}

/**
 * SQL creating the table that records how far the folds have reached.
 *
 * One row, typed columns. The cursor is a molecular weight, and a weight stored
 * as text keeps only 15 significant digits, so a resumed fold would seek to a
 * slightly different place and skip or repeat a row.
 *
 * - `folded_through`: every entry whose id is at most this is folded or waits
 *   in the tail; NULL until the first fold completes.
 * - `tail_through`: the trigger copies an inserted fingerprint into the tail
 *   when its entry id is at most this. It equals `folded_through` between folds
 *   and is raised to the fold's snapshot before the fold reads anything.
 * - `cursor_mw`, `cursor_entry_id`: the last row a fold in progress published,
 *   NULL when no fold is in progress.
 * - `segment`: the segment the fold in progress extends.
 * @returns SQL ready for db.exec().
 */
export function buildFoldTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${FOLD_TABLE} (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  folded_through  INTEGER,
  tail_through    INTEGER,
  cursor_mw       REAL,
  cursor_entry_id INTEGER,
  segment         INTEGER
);`;
}

/**
 * SQL creating the triggers that keep the tail filled.
 *
 * A fold finds most of what it has not folded yet above its watermark, through
 * `ocl_ss_index`'s entry index, so only a fingerprint whose entry id is at or
 * below `tail_through` is copied: an entry inserted out of order, or inserted
 * again. A caller whose ids only grow therefore stores nothing twice.
 *
 * The bound is the fold's snapshot, raised before the fold reads anything, not
 * the watermark it starts from. An id between the two inserted while the fold
 * runs may be behind its cursor already, so the tail is the only place the next
 * fold can find it.
 *
 * Triggers rather than lines in `insert()`: the tail is an implementation detail
 * of the plane index, so a caller writing `ocl_ss_index` itself is covered too,
 * and no insert path can forget. The delete trigger keeps a deleted entry from
 * being folded later.
 * @returns SQL ready for db.exec().
 */
export function buildTailTriggerSql(): string {
  return `CREATE TRIGGER IF NOT EXISTS ${TAIL_TRIGGER}
AFTER INSERT ON ocl_ss_index
WHEN NEW.entry_id <= (SELECT tail_through FROM ${FOLD_TABLE} WHERE id = 1)
BEGIN
  INSERT OR REPLACE INTO ${TAIL_TABLE}
    (mw, entry_id, ss_index0, ss_index1, ss_index2, ss_index3,
     ss_index4, ss_index5, ss_index6, ss_index7)
  VALUES
    (NEW.mw, NEW.entry_id, NEW.ss_index0, NEW.ss_index1, NEW.ss_index2,
     NEW.ss_index3, NEW.ss_index4, NEW.ss_index5, NEW.ss_index6,
     NEW.ss_index7);
END;
CREATE TRIGGER IF NOT EXISTS ${TAIL_DELETE_TRIGGER}
AFTER DELETE ON ocl_ss_index
BEGIN
  DELETE FROM ${TAIL_TABLE} WHERE entry_id = OLD.entry_id;
END;`;
}

/**
 * SQL creating version 5's trigger, which copied every new fingerprint into the
 * tail.
 *
 * Kept verbatim although version 6 replaces it: migrations replay from whatever
 * version a database is at, so a fresh database still walks through it.
 * @returns SQL ready for db.exec().
 */
export function buildTailTriggerSqlV5(): string {
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
