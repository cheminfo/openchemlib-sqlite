import type * as OpenChemLib from 'openchemlib';

import { buildSchemaSql } from '../schema.ts';
import type { SQLiteDatabase } from '../types.ts';

type OCLLibrary = typeof OpenChemLib;

/** Entries-table coordinates needed to recompute each molecule's weight. */
export interface LegacyMigrationConfig {
  entriesTable: string;
  pkColumn: string;
  idCodeColumn: string;
}

// The fingerprint columns hold packed signed 64-bit integers that overflow a JS
// number, so the row is read with setReadBigInts(true): every INTEGER column
// (entryId included) comes back as a bigint and is bound straight back, never
// interpreted here. Only idCode (TEXT) drives the mw recomputation.
interface LegacyRow {
  entryId: bigint;
  idCode: string | null;
  ssIndex0: bigint;
  ssIndex1: bigint;
  ssIndex2: bigint;
  ssIndex3: bigint;
  ssIndex4: bigint;
  ssIndex5: bigint;
  ssIndex6: bigint;
  ssIndex7: bigint;
}

const BATCH_SIZE = 1000;

/**
 * Upgrade a pre-mw `ocl_ss_index` to the current mw-clustered schema.
 *
 * Versions of this package before molecular-weight clustering stored
 * `ocl_ss_index` with `entry_id` as the primary key and no `mw` column. That
 * shape has no place for the weight the substructure scan orders by, so a plain
 * `CREATE TABLE IF NOT EXISTS` leaves it untouched and search breaks. This
 * function detects the legacy table (or a migration interrupted partway) and
 * rebuilds it in place: every stored fingerprint is preserved and each row's
 * `mw` is derived from its molecule, whose idCode is read from the entries
 * table. Rows are drained from the renamed legacy table in small committed
 * batches, so the write lock is never held for long and the work is resumable —
 * a crash leaves the not-yet-migrated rows in `ocl_ss_index_legacy`, which a
 * later call finishes draining.
 * @param db - Open database handle.
 * @param ocl - The OpenChemLib module used to parse idCodes.
 * @param config - Entries-table name, primary key, and idCode column.
 * @returns The number of rows migrated (0 when no migration was needed).
 */
export function migrateLegacyIndexToMw(
  db: SQLiteDatabase,
  ocl: OCLLibrary,
  config: LegacyMigrationConfig,
): number {
  if (!startLegacyMigration(db)) return 0;

  // The mw-clustered table; IF NOT EXISTS so a resumed run reuses the one a
  // previous (interrupted) run already created.
  db.exec(buildSchemaSql(config));

  const select = db.prepare(
    `SELECT l.entry_id AS entryId, e.${config.idCodeColumn} AS idCode,
            l.ss_index0 AS ssIndex0, l.ss_index1 AS ssIndex1,
            l.ss_index2 AS ssIndex2, l.ss_index3 AS ssIndex3,
            l.ss_index4 AS ssIndex4, l.ss_index5 AS ssIndex5,
            l.ss_index6 AS ssIndex6, l.ss_index7 AS ssIndex7
       FROM ocl_ss_index_legacy l
       LEFT JOIN ${config.entriesTable} e ON e.${config.pkColumn} = l.entry_id
      ORDER BY l.entry_id
      LIMIT ${BATCH_SIZE}`,
  );
  select.setReadBigInts?.(true);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO ocl_ss_index (mw, entry_id, ss_index0, ss_index1, ss_index2, ss_index3, ss_index4, ss_index5, ss_index6, ss_index7) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // Rows are the BATCH_SIZE smallest entry_ids, so deleting up to the largest of
  // them removes exactly the batch just migrated and lets the next SELECT take
  // the following window.
  const deleteUpTo = db.prepare(
    'DELETE FROM ocl_ss_index_legacy WHERE entry_id <= ?',
  );

  let migrated = 0;
  for (;;) {
    const rows = select.all() as LegacyRow[];
    if (rows.length === 0) break;
    let lastEntryId = 0n;
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        insert.run(
          molecularWeight(ocl, row.idCode),
          row.entryId,
          row.ssIndex0,
          row.ssIndex1,
          row.ssIndex2,
          row.ssIndex3,
          row.ssIndex4,
          row.ssIndex5,
          row.ssIndex6,
          row.ssIndex7,
        );
        lastEntryId = row.entryId;
      }
      deleteUpTo.run(lastEntryId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    migrated += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  db.exec('DROP TABLE ocl_ss_index_legacy');
  return migrated;
}

/**
 * Decide whether legacy data must be drained and, if the original table is still
 * in its pre-mw shape, rename it aside so the rebuild can begin.
 * @param db - Open database handle.
 * @returns True when `ocl_ss_index_legacy` holds rows to migrate (freshly
 *   renamed or left over from an interrupted run), false when the index is
 *   absent or already mw-clustered.
 */
function startLegacyMigration(db: SQLiteDatabase): boolean {
  if (tableExists(db, 'ocl_ss_index_legacy')) return true;
  if (!tableExists(db, 'ocl_ss_index')) return false;
  if (hasColumn(db, 'ocl_ss_index', 'mw')) return false;
  db.exec('ALTER TABLE ocl_ss_index RENAME TO ocl_ss_index_legacy');
  return true;
}

function tableExists(db: SQLiteDatabase, name: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name);
  return row !== undefined;
}

function hasColumn(db: SQLiteDatabase, table: string, column: string): boolean {
  // `table` is an internal constant ('ocl_ss_index'), never user input.
  const row = db
    .prepare(
      `SELECT 1 AS present FROM pragma_table_info('${table}') WHERE name = ?`,
    )
    .get(column);
  return row !== undefined;
}

function molecularWeight(ocl: OCLLibrary, idCode: string | null): number {
  if (!idCode) return 0;
  try {
    return ocl.Molecule.fromIDCode(idCode).getMolecularFormula().relativeWeight;
  } catch {
    // an orphaned or unparseable entry sorts first (mw = 0)
    return 0;
  }
}
