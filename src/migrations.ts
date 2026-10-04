import type * as OpenChemLib from 'openchemlib';

import { buildPlaneSchemaSqlV5 } from './planes/planeSchema.ts';
import { upgradeToWatermark } from './planes/upgradeToWatermark.ts';
import {
  FOLD_TABLE,
  buildWatermarkTriggersSql,
} from './planes/watermarkSchema.ts';
import {
  NO_STEREO_HASH_TABLE,
  NO_STEREO_TAUTOMER_HASH_TABLE,
  VERSION_TABLE,
  buildHashTableSql,
  buildSchemaSqlV1,
  buildSettingsTableSql,
  buildVersionTableSql,
} from './schema.ts';
import type { MigrationEvent, SQLiteDatabase } from './types.ts';
import { upgradeToMwClustered } from './upgradeToMwClustered.ts';
import { buildColumnsTableSql } from './utils/indexColumns.ts';

type OCLLibrary = typeof OpenChemLib;

/** Everything a migration needs to rewrite the index. */
export interface MigrationContext {
  db: SQLiteDatabase;
  ocl: OCLLibrary;
  entriesTable: string;
  pkColumn: string;
  idCodeColumn: string;
  /** Column on the entries table holding each molecule's weight, if any. */
  mwColumn: string | null;
  onMigration?: (event: MigrationEvent) => void;
}

/** One irreversible step from version-1 to version. */
export interface Migration {
  /** Schema version this step produces. */
  version: number;
  description: string;
  /**
   * Apply the step. Returns how many unusable rows it discarded, if any.
   */
  up: (context: MigrationContext) => number | void;
}

/**
 * Every schema version, in order. A database at version N applies N+1, N+2, ...
 * until it reaches the last entry here, so this list is the whole story of how
 * the index has ever evolved.
 *
 * Adding a version: append a migration, never edit a shipped one. A shipped
 * migration has already run on real databases, so changing it changes what
 * different installations contain.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'create the ocl_ss_index fingerprint table',
    up: ({ db, entriesTable, pkColumn }) => {
      db.exec(buildSchemaSqlV1({ entriesTable, pkColumn }));
    },
  },
  {
    version: 2,
    description: 'cluster ocl_ss_index by molecular weight',
    up: upgradeToMwClustered,
  },
  {
    version: 3,
    description: 'create the structure hash tables',
    up: ({ db, entriesTable, pkColumn }) => {
      // Only the tables: filling them is minutes to hours of canonization, which
      // cannot run inside a migration's transaction. `backfillHashes()` does
      // that, chunked and resumable, whenever the caller chooses.
      const config = { entriesTable, pkColumn };
      db.exec(buildHashTableSql(config, NO_STEREO_HASH_TABLE));
      db.exec(buildHashTableSql(config, NO_STEREO_TAUTOMER_HASH_TABLE));
    },
  },
  {
    version: 4,
    description: 'discard hashes computed before openchemlib-search-wasm 2.0.0',
    up: ({ db, entriesTable, pkColumn }) => {
      // openchemlib-search-wasm 2.0.0 fixed a defect that gave the wrong hash to
      // a molecule whose stereogenic double bond carries no configuration —
      // about 1.5% of a drug-like library. A database filled before it holds
      // those wrong values, and nothing about a stored hash says which version
      // computed it, so the only safe answer is to drop them and let
      // `backfillHashes()` fill them again.
      //
      // Dropped rather than emptied: `DELETE FROM` walks every row and this
      // table has one per entry, which on a large corpus is minutes inside a
      // migration's transaction.
      const config = { entriesTable, pkColumn };
      for (const table of [
        NO_STEREO_HASH_TABLE,
        NO_STEREO_TAUTOMER_HASH_TABLE,
      ]) {
        db.exec(`DROP TABLE IF EXISTS ${table}`);
        db.exec(buildHashTableSql(config, table));
      }
      // The tautomer hashes are bounded by a ceiling from here on, and which
      // molecules have one depends on it, so it is recorded alongside them.
      db.exec(buildSettingsTableSql());
    },
  },
  {
    version: 5,
    description: 'create the transposed plane index and its tail',
    up: ({ db, entriesTable, pkColumn }) => {
      // Only the tables and the trigger. Filling them transposes every
      // fingerprint in the database, which is the same order of work as a hash
      // backfill and cannot run inside a migration's transaction: `foldPlanes()`
      // does it, chunk by chunk and resumable, whenever the caller chooses.
      //
      // Until it has run the index is empty, every search stays on the column
      // path, and nothing about the database's behaviour changes.
      db.exec(buildPlaneSchemaSqlV5({ entriesTable, pkColumn }));
    },
  },
  {
    version: 6,
    description:
      'drop the tail; trust the planes up to an entry-id watermark; record carried columns',
    up: ({ db }) => {
      upgradeToWatermark(db);
      // Only the record: the columns themselves are the caller's to declare,
      // and `migrate()` adds them whatever version a database is at.
      db.exec(buildColumnsTableSql());
    },
  },
];

/** The version a freshly-migrated database ends up at. */
export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/**
 * Apply every migration this database still owes.
 *
 * Migrations run inside one transaction each, so a database is never left
 * half-upgraded: either a version is fully applied and recorded, or nothing
 * changed and the error propagates.
 * @param context - The database, OCL, the column config, and the log callback.
 * @returns The versions applied, in order (empty when already current).
 */
export function runMigrations(context: MigrationContext): number[] {
  const { db, onMigration } = context;
  db.exec(buildVersionTableSql());
  const from = detectVersion(db);
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    const start = Date.now();
    onMigration?.({
      version: migration.version,
      description: migration.description,
      phase: 'start',
    });
    db.exec('BEGIN');
    let dropped: number | void;
    try {
      dropped = migration.up(context);
      db.prepare(`INSERT INTO ${VERSION_TABLE} (version) VALUES (?)`).run(
        migration.version,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    onMigration?.({
      version: migration.version,
      description: migration.description,
      phase: 'done',
      elapsedMs: Date.now() - start,
      ...(dropped ? { dropped } : {}),
    });
    applied.push(migration.version);
  }

  reassertWatermarkTriggers(db);
  return applied;
}

/**
 * Put the watermark triggers back if anything has dropped them.
 *
 * SQLite drops a trigger with the table it watches, so any later migration that
 * rebuilds `ocl_ss_index` — as version 2 did, under a temporary name before
 * swapping it in — takes them with it. Nothing would report that: inserts would
 * keep working, an entry written below the watermark would simply leave it
 * where it is, and a search answered from the plane index would quietly miss
 * that entry.
 *
 * So they are re-asserted on every `migrate()` rather than trusted to the one
 * migration that created them. `CREATE TRIGGER IF NOT EXISTS` makes that free
 * when they are already there.
 * @param db - The database to repair.
 */
function reassertWatermarkTriggers(db: SQLiteDatabase): void {
  if (!tableExists(db, FOLD_TABLE)) return;
  db.exec(buildWatermarkTriggersSql());
}

/**
 * Work out which version a database is at.
 *
 * Databases created before the version table existed have to be recognised by
 * shape — once. From then on the recorded version answers the question, so this
 * inference never has to grow another branch.
 * @param db - The database.
 * @returns The schema version currently on disk (0 when there is no index yet).
 */
function detectVersion(db: SQLiteDatabase): number {
  const recorded = db
    .prepare(`SELECT MAX(version) AS version FROM ${VERSION_TABLE}`)
    .get() as { version: number | null } | undefined;
  if (recorded?.version != null) return recorded.version;

  if (!tableExists(db, 'ocl_ss_index')) return 0;
  // Pre-versioning database: v2 added the mw column, v1 had no such thing.
  return hasColumn(db, 'ocl_ss_index', 'mw') ? 2 : 1;
}

function tableExists(db: SQLiteDatabase, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return row !== undefined;
}

function hasColumn(db: SQLiteDatabase, table: string, column: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(table) as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}
