import { SLOT_TABLE } from './planeSchema.ts';

/** Single-row table recording how far the plane index can be trusted. */
export const FOLD_TABLE = 'ocl_ss_fold';

/** The triggers that lower the watermark, in the order they are created. */
export const WATERMARK_TRIGGERS = [
  'ocl_ss_watermark_insert',
  'ocl_ss_watermark_replace',
  'ocl_ss_watermark_update',
  'ocl_ss_watermark_delete',
] as const;

/**
 * SQL creating the table that records how far the plane index can be trusted,
 * with its one row.
 *
 * - `watermark`: every entry whose id is at most this is in the planes, with
 *   its current fingerprint. A search reads the planes for those entries and
 *   `ocl_ss_index` for every other one. NULL trusts the planes for nothing,
 *   which is where a database that never folded stays.
 * - `bound`: a write to an entry whose id is at most this is checked by the
 *   triggers. It equals `watermark` between folds, and is raised to the fold's
 *   snapshot while one runs: an entry the fold may already have read past must
 *   keep the watermark it is about to set below it.
 * - `cursor_mw`, `cursor_entry_id`: the last row a fold in progress published,
 *   NULL when no fold is in progress. Typed REAL, because a weight stored as
 *   text keeps only 15 significant digits and a resumed fold would seek to a
 *   slightly different place.
 * - `segment`: the segment the fold in progress extends.
 * @returns SQL ready for db.exec().
 */
export function buildFoldTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${FOLD_TABLE} (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  watermark       INTEGER,
  bound           INTEGER,
  cursor_mw       REAL,
  cursor_entry_id INTEGER,
  segment         INTEGER
);
INSERT OR IGNORE INTO ${FOLD_TABLE} (id) VALUES (1);`;
}

const BOUND = `(SELECT bound FROM ${FOLD_TABLE} WHERE id = 1)`;

/**
 * The statement moving the watermark, and the bound, below an entry id.
 * @param id - SQL for the entry id written.
 * @returns The statement, to run inside a trigger.
 */
function lowerBelow(id: string): string {
  return `UPDATE ${FOLD_TABLE}
     SET watermark = MIN(watermark, ${id} - 1), bound = MIN(bound, ${id} - 1)
   WHERE id = 1 AND ${id} <= bound;`;
}

/**
 * SQL testing that two rows hold the same fingerprint.
 * @param a - The first row's alias.
 * @param b - The second row's alias.
 * @returns The condition.
 */
function sameFingerprint(a: string, b: string): string {
  const words: string[] = [];
  for (let word = 0; word < 8; word++) {
    words.push(`${a}.ss_index${word} = ${b}.ss_index${word}`);
  }
  return words.join(' AND ');
}

/**
 * SQL creating the triggers that keep the watermark honest: the check that ids
 * only grow.
 *
 * The planes are appended to, never rewritten, so they can only be trusted up
 * to an id below which nothing has changed since it was folded. An entry
 * written with a larger id — the normal case, ids that only grow — touches
 * neither the planes nor this table: it is read from `ocl_ss_index` until the
 * next fold. A write at or below `bound` is what these catch:
 *
 * - `insert`: an entry that holds no slot — a new id below the watermark, or
 *   an id given again after its entry was removed — lowers the watermark below
 *   it.
 * - `replace`: an entry inserted again with another fingerprint lowers it too.
 *   Inserted again with the same one, it changes nothing the planes hold and
 *   leaves the watermark where it is. This one runs before the insert, because
 *   only then is the row it replaces still there to compare with.
 * - `update`: a fingerprint or an entry id changed in place lowers it below the
 *   smaller of the two ids, and an entry id that moved loses its slot.
 * - `delete`: a removed entry loses its slot, so no search can resolve its bits
 *   and an id given again later is seen as new. The watermark does not move:
 *   the planes still hold every other entry exactly.
 *
 * Triggers rather than lines in `insert()`: a caller writing `ocl_ss_index`
 * itself is checked too, and the check is part of the write's own transaction,
 * so no fold running beside it on another connection can slip between the two.
 * An `INSERT OR IGNORE` that ignores its row still runs the `replace` trigger;
 * at worst that lowers the watermark for nothing, never the other way.
 * @returns SQL ready for db.exec().
 */
export function buildWatermarkTriggersSql(): string {
  const [insert, replace, update, remove] = WATERMARK_TRIGGERS;
  return `CREATE TRIGGER IF NOT EXISTS ${insert}
AFTER INSERT ON ocl_ss_index
WHEN NEW.entry_id <= ${BOUND}
  AND NOT EXISTS (SELECT 1 FROM ${SLOT_TABLE} WHERE entry_id = NEW.entry_id)
BEGIN
  ${lowerBelow('NEW.entry_id')}
END;
CREATE TRIGGER IF NOT EXISTS ${replace}
BEFORE INSERT ON ocl_ss_index
WHEN NEW.entry_id <= ${BOUND}
  AND EXISTS (SELECT 1 FROM ocl_ss_index o
               WHERE o.entry_id = NEW.entry_id
                 AND NOT (${sameFingerprint('o', 'NEW')}))
BEGIN
  ${lowerBelow('NEW.entry_id')}
END;
CREATE TRIGGER IF NOT EXISTS ${update}
AFTER UPDATE ON ocl_ss_index
WHEN OLD.entry_id <> NEW.entry_id OR NOT (${sameFingerprint('OLD', 'NEW')})
BEGIN
  ${lowerBelow('MIN(OLD.entry_id, NEW.entry_id)')}
  DELETE FROM ${SLOT_TABLE}
   WHERE entry_id = OLD.entry_id AND OLD.entry_id <> NEW.entry_id;
END;
CREATE TRIGGER IF NOT EXISTS ${remove}
AFTER DELETE ON ocl_ss_index
BEGIN
  DELETE FROM ${SLOT_TABLE} WHERE entry_id = OLD.entry_id;
END;`;
}
