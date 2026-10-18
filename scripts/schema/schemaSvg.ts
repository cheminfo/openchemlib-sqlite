import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { FORMAT, MoleculeStore } from '../../src/index.ts';
import { REBUILD_SQL } from '../../src/store/rebuildSchema.ts';
import {
  V5_CHANGES_SQL,
  V5_IDS_SQL,
  v5TriggerSql,
} from '../../src/store/v5Schema.ts';

import { drawSchema } from './drawSchema.ts';
import { parseSchema } from './parseSchema.ts';

/** The application's table the migration frame draws its triggers on. */
const ENTRIES = { table: 'entries', key: 'id', idCode: 'idCode' };
const ENTRIES_SQL =
  'CREATE TABLE entries (id INTEGER PRIMARY KEY, idCode TEXT NOT NULL)';

/** The statements that create each part, as SQLite keeps them. */
export interface ScratchSchema {
  /** What `MoleculeStore.open()` creates in a new file. */
  store: string;
  /** What a rebuild adds beside it. */
  rebuild: string;
  /** What a migration from 5.x adds, triggers on the application's table included. */
  migration: string;
}

/**
 * The schema drawing, from what this checkout of the library creates.
 * @returns the SVG document
 */
export async function schemaSvg(): Promise<string> {
  const sql = await scratchSchemaSql();
  return drawSchema({
    store: parseSchema(sql.store),
    rebuild: parseSchema(sql.rebuild),
    migration: parseSchema(sql.migration),
    format: FORMAT,
  });
}

/**
 * The statements of each part, read back from scratch databases: a store
 * opened on a new one, the same file once a rebuild's tables are added, and a
 * migration's tables beside an application's table, so the drawing cannot
 * drift from the code that creates them.
 * @returns each part's statements, each ending with a semicolon, in the order
 * SQLite keeps them
 */
export async function scratchSchemaSql(): Promise<ScratchSchema> {
  const db = new DatabaseSync(':memory:');
  const migration = new DatabaseSync(':memory:');
  try {
    const store = await MoleculeStore.open(db, { threads: 1, checkRows: 0 });
    await store.close();
    const stored = statementsOf(db);
    for (const sql of REBUILD_SQL) db.exec(sql);
    const rebuild = statementsOf(db).filter((sql) => !stored.includes(sql));
    // The application's table, named `entries` here: the triggers need one to sit on.
    migration.exec(ENTRIES_SQL);
    for (const sql of [...V5_IDS_SQL, V5_CHANGES_SQL]) migration.exec(sql);
    for (const sql of v5TriggerSql(ENTRIES)) migration.exec(sql);
    return {
      store: stored.join('\n'),
      rebuild: rebuild.join('\n'),
      migration: statementsOf(migration)
        .filter((sql) => sql !== `${ENTRIES_SQL};`)
        .join('\n'),
    };
  } finally {
    db.close();
    migration.close();
  }
}

/**
 * Where the drawing is kept in the repository.
 * @returns the path of `docs/schema.svg`
 */
export function schemaSvgPath(): string {
  return join(import.meta.dirname, '../../docs/schema.svg');
}

/**
 * The statements a database keeps, SQLite's own tables left out.
 * @param db - the database
 * @returns each statement, ending with a semicolon
 */
function statementsOf(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT sql FROM sqlite_schema
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY rowid`,
    )
    .all() as Array<{ sql: string }>;
  return rows.map((row) => `${row.sql};`);
}
