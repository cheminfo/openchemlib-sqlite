import type { DatabaseSync } from 'node:sqlite';

import type { V5Counts } from './migrateV5Convert.ts';
import { V5Converter, writeTransaction } from './migrateV5Convert.ts';
import { V5Run } from './migrateV5Run.ts';
import { openStoreParts } from './openStore.ts';
import type { V5Entries } from './v5Schema.ts';
import {
  V5_CHANGES_SQL,
  V5_IDS_SQL,
  checkEntries,
  v5State,
  v5Tables,
  v5TriggerSql,
} from './v5Schema.ts';

/** Changes a call that does not end the migration leaves logged: the last rounds stay short. */
const LEFT_CHANGES = 512;

/** How a 5.x file is migrated. */
export interface MigrateFromV5Options {
  /** The application's table 5.x indexed, as its `MoleculesDBSQLite` was configured. */
  entries: V5Entries;
  /**
   * Threads computing the molecules.
   * @default availableParallelism() - 1
   */
  threads?: number;
  /**
   * Entries per write transaction.
   * @default 1000
   */
  chunkSize?: number;
  /**
   * Ends the migration: the last changes are converted, the triggers and the log removed, and the
   * file marked migrated. Stop the 5.x writers first: a write landing meanwhile only delays it.
   * @default false
   */
  finish?: boolean;
  /** Stops it between steps; the next call continues from there. */
  signal?: AbortSignal;
  /** Hears what was done after each step. */
  onProgress?: (counts: V5Counts) => void;
}

/** What a call did. */
export interface MigrateFromV5Result extends V5Counts {
  /** Changes logged and not converted yet: what a later call, or the end, takes. */
  pending: number;
  /** Whether the migration ended: `MoleculeStore.open()` takes the file from now on. */
  migrated: boolean;
}

/**
 * Migrates a file of openchemlib-sqlite 5.x in place, while the 5.x application keeps serving and
 * writing it. The library's 6.x tables are created beside the 5.x ones, whose names they do not
 * share; every entry of the application's table is converted from its idCode, a chunk per short
 * write transaction, and the id it got is kept in `ocl_v5_ids` (`entry`, `id`, `error`) for the
 * application to re-key its own rows. Triggers on that table log what the 5.x writers change
 * meanwhile, and each call converts those entries again until few are left. Call it with `finish`
 * once the 5.x writers are stopped. Resumable: a call that stops is continued by the next one.
 * @param db - A connection of its own, with a busy timeout, outside any transaction: the 5.x
 * application keeps writing the file meanwhile.
 * @param options - The application's table, threads, chunk size, the end, cancellation, progress.
 * @returns What the call did.
 */
export async function migrateFromV5(
  db: DatabaseSync,
  options: MigrateFromV5Options,
): Promise<MigrateFromV5Result> {
  const { entries, threads, chunkSize = 1000, finish = false } = options;
  const { signal, onProgress } = options;
  const state = v5State(db);
  if (state === 'migrated') {
    return { entries: 0, created: 0, failed: 0, pending: 0, migrated: true };
  }
  if (state === '' && v5Tables(db).length === 0) {
    throw new Error(
      'no table of openchemlib-sqlite 5.x in this file: nothing to migrate',
    );
  }
  checkEntries(db, entries);
  const parts = await openStoreParts(
    db,
    { ...(threads === undefined ? {} : { threads }), checkRows: 0 },
    true,
  );
  try {
    beginV5(db, entries);
    const converter = new V5Converter(db, parts);
    const run = new V5Run(db, converter, entries, () =>
      onProgress?.({ ...converter.counts }),
    );
    await run.firstPass(chunkSize, signal);
    if (finish) await run.finish(signal);
    else await run.catchUp(LEFT_CHANGES, signal);
    return { ...converter.counts, pending: run.pending(), migrated: finish };
  } finally {
    await parts.pool.close();
  }
}

/**
 * Starts the migration, or checks that the one under way is for the same table: the ids table,
 * the log of changes and its triggers, created with the state in one transaction.
 * @param db - The connection.
 * @param entries - The application's table.
 */
function beginV5(db: DatabaseSync, entries: V5Entries): void {
  const wanted = JSON.stringify({
    table: entries.table,
    key: entries.key,
    idCode: entries.idCode,
  });
  const stored = db
    .prepare("SELECT value FROM ocl_meta WHERE name = 'v5.entries'")
    .get() as { value: string } | undefined;
  if (stored !== undefined) {
    if (stored.value !== wanted) {
      throw new Error(
        `the migration under way reads ${stored.value}, not ${wanted}`,
      );
    }
    return;
  }
  writeTransaction(db, () => {
    for (const sql of V5_IDS_SQL) db.exec(sql);
    db.exec(V5_CHANGES_SQL);
    for (const sql of v5TriggerSql(entries)) db.exec(sql);
    const set = db.prepare(
      'INSERT OR REPLACE INTO ocl_meta (name, value) VALUES (?, ?)',
    );
    set.run('v5.state', 'migrating');
    set.run('v5.entries', wanted);
  });
}
