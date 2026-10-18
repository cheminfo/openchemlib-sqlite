import type { DatabaseSync } from 'node:sqlite';

import { dropInSteps } from './dropInSteps.ts';
import { writeTransaction } from './migrateV5Convert.ts';
import { hasTable } from './schema.ts';
import { quoteName, v5State, v5Tables } from './v5Schema.ts';

/** What {@link dropV5Tables} removed. */
export interface DropV5Result {
  /** The tables dropped: the 5.x ones, and `ocl_v5_ids`. */
  tables: string[];
}

/** The size of a database file before and after {@link compactDatabase}. */
export interface CompactResult {
  /** Bytes before. */
  before: number;
  /** Bytes after. */
  after: number;
}

/**
 * Drops what 5.x left in a migrated file, a few thousand rows per short write transaction, so the
 * application keeps writing meanwhile: the 5.x tables, then `ocl_v5_ids`. Call it once the
 * application has re-keyed its rows. Their pages stay in the file, free for new rows, until
 * {@link compactDatabase} returns them.
 * @param db - The application's connection, outside any transaction.
 * @returns What was dropped.
 */
export async function dropV5Tables(db: DatabaseSync): Promise<DropV5Result> {
  if (v5State(db) !== 'migrated') {
    throw new Error(
      'the file is not migrated from 5.x: end the migration with migrateFromV5({ entries, finish: true }) first',
    );
  }
  const tables = v5Tables(db);
  if (hasTable(db, 'ocl_v5_ids')) tables.push('ocl_v5_ids');
  writeTransaction(db, () => {
    // 5.x keeps triggers on its tables, which would run for every row deleted below.
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(tables)) as Array<{ name: string }>;
    for (const { name } of triggers) db.exec(`DROP TRIGGER ${quoteName(name)}`);
  });
  for (const table of tables) {
    // eslint-disable-next-line no-await-in-loop -- one table at a time, the writers in between
    await dropInSteps(db, table, keyColumns(db, table));
  }
  writeTransaction(db, () => {
    db.exec("DELETE FROM ocl_meta WHERE name LIKE 'v5.%'");
  });
  return { tables };
}

/**
 * Rewrites the whole file without its free pages (`VACUUM`), then truncates the write-ahead log.
 * Not live: it holds the write lock for its whole run, minutes for a file of tens of gigabytes,
 * and needs about as much free disk as the file. It may renumber the rows of a table without an
 * INTEGER PRIMARY KEY; the library's tables all have one.
 * @param db - The connection, outside any transaction.
 * @returns The file's size before and after.
 */
export function compactDatabase(db: DatabaseSync): CompactResult {
  if (db.isTransaction) {
    throw new Error('compactDatabase() runs outside any transaction');
  }
  const before = fileBytes(db);
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { before, after: fileBytes(db) };
}

/**
 * The columns a table's rows are deleted by: its rowid, or its primary key without one.
 * @param db - The connection.
 * @param table - The table.
 * @returns The columns, quoted.
 */
function keyColumns(db: DatabaseSync, table: string): string[] {
  const listed = db.prepare(`PRAGMA table_list(${quoteName(table)})`).get() as
    { wr: number } | undefined;
  if (listed?.wr !== 1) return ['rowid'];
  const columns = db
    .prepare(`PRAGMA table_info(${quoteName(table)})`)
    .all() as Array<{ name: string; pk: number }>;
  return columns
    .filter((column) => column.pk > 0)
    .toSorted((first, second) => first.pk - second.pk)
    .map((column) => quoteName(column.name));
}

function fileBytes(db: DatabaseSync): number {
  const row = db
    .prepare(
      'SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()',
    )
    .get() as { bytes: number };
  return row.bytes;
}
