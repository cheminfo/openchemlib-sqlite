import type * as OpenChemLib from 'openchemlib';

import type { MigrationContext } from './migrations.ts';
import { buildEntryIndexSql, buildSchemaSqlV2 } from './schema.ts';

type OCLLibrary = typeof OpenChemLib;

// Rows rewritten between progress reports. Small enough that a large migration
// reports often, large enough that reporting is not the cost.
const PROGRESS_EVERY = 2000;

/**
 * Rebuild ocl_ss_index clustered by molecular weight.
 *
 * The fingerprints are carried over, not recomputed: they are the expensive part
 * (~6 ms a molecule) and the schema change does not affect them. Only `mw` is
 * new. When the caller configured an mwColumn it comes straight from the entries
 * table in one INSERT ... SELECT; otherwise it is derived from each idCode, which
 * is a parse plus a formula and still an order of magnitude cheaper than
 * re-fingerprinting.
 *
 * The whole rebuild is one transaction (the caller's), which is what makes it
 * safe to interrupt — but it does hold the write lock for its duration. That is
 * accepted here: it runs once, at startup, and a half-swapped index has no valid
 * intermediate state to expose.
 * @param context - The database, OCL, the column config, and the log callback.
 * @returns How many orphaned fingerprints were dropped.
 */
export function upgradeToMwClustered(context: MigrationContext): number {
  const {
    db,
    ocl,
    entriesTable,
    pkColumn,
    idCodeColumn,
    mwColumn,
    onMigration,
  } = context;
  const temporary = 'ocl_ss_index_migrating';
  const columns =
    'ss_index0, ss_index1, ss_index2, ss_index3, ss_index4, ss_index5, ss_index6, ss_index7';

  db.exec(`DROP TABLE IF EXISTS ${temporary}`);
  db.exec(buildSchemaSqlV2({ entriesTable, pkColumn }, temporary));

  const total = (
    db.prepare('SELECT COUNT(*) AS n FROM ocl_ss_index').get() as { n: number }
  ).n;
  const report = (done: number) =>
    onMigration?.({
      version: 2,
      description: 'cluster ocl_ss_index by molecular weight',
      phase: 'progress',
      done,
      total,
    });

  // A fingerprint whose entry no longer exists cannot be carried over: the new
  // table has the same foreign key the old one did, and the search inner-joins
  // the entries table anyway, so such a row could never match. It is dropped —
  // but counted and reported, because a migration that quietly discards rows is
  // indistinguishable from one that loses them.
  const orphans = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ocl_ss_index o
         WHERE NOT EXISTS (SELECT 1 FROM ${entriesTable} e WHERE e.${pkColumn} = o.entry_id)`,
      )
      .get() as { n: number }
  ).n;

  if (mwColumn) {
    // The weight is already in the entries table: pure SQL, no molecule parsed.
    db.exec(
      `INSERT INTO ${temporary} (mw, entry_id, ${columns})
       SELECT COALESCE(e.${mwColumn}, 0), o.entry_id, ${columns}
       FROM ocl_ss_index o
       JOIN ${entriesTable} e ON e.${pkColumn} = o.entry_id`,
    );
    report(total);
  } else {
    const insert = db.prepare(
      `INSERT INTO ${temporary} (mw, entry_id, ${columns})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const read = db.prepare(
      `SELECT o.entry_id, ${columns}, e.${idCodeColumn} AS id_code
       FROM ocl_ss_index o
       JOIN ${entriesTable} e ON e.${pkColumn} = o.entry_id`,
    );
    read.setReadBigInts?.(true);
    // Stream when the driver can, so a large index is not held in memory twice
    // while it is being rewritten.
    const rows = (read.iterate ? read.iterate() : read.all()) as Iterable<
      Record<string, unknown>
    >;
    let done = 0;
    for (const row of rows) {
      insert.run(
        molecularWeight(ocl, row.id_code as string | null),
        Number(row.entry_id),
        row.ss_index0,
        row.ss_index1,
        row.ss_index2,
        row.ss_index3,
        row.ss_index4,
        row.ss_index5,
        row.ss_index6,
        row.ss_index7,
      );
      if (++done % PROGRESS_EVERY === 0) report(done);
    }
    report(done);
  }

  db.exec('DROP TABLE ocl_ss_index');
  db.exec(`ALTER TABLE ${temporary} RENAME TO ocl_ss_index`);
  db.exec(buildEntryIndexSql());
  return orphans;
}

/**
 * Molecular weight of an idCode, or 0 when it cannot be computed.
 * @param ocl - OpenChemLib namespace.
 * @param idCode - The stored idCode, or null for an orphaned fingerprint.
 * @returns The relative weight; 0 sorts such a row first, as insert() does.
 */
function molecularWeight(ocl: OCLLibrary, idCode: string | null): number {
  if (!idCode) return 0;
  try {
    // `false` skips 2D-coordinate invention: the formula is graph-derived.
    return ocl.Molecule.fromIDCode(idCode, false).getMolecularFormula()
      .relativeWeight;
  } catch {
    return 0;
  }
}
