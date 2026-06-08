import * as OCL from 'openchemlib';
import { workerEmit } from 'workerpool';

import { MoleculesDBSQLite } from './MoleculesDBSQLite.ts';
import type { InputFormat, MoleculesDBConfig, SearchResult } from './types.ts';

/** One partition of a parallel substructure scan, sent to a worker. */
export interface PartitionTask {
  /** Specifier the worker re-imports this module from (set by the pool). */
  workerModule: string;
  /** Path of the SQLite file this worker opens. */
  dbPath: string;
  /** Column config (no `poolSize`) describing the entries table and index. */
  config: MoleculesDBConfig;
  /** Query as an OCL idCode (cheap to transfer). */
  query: string;
  /** Input format of `query`. */
  format: InputFormat;
  /** Maximum matches this partition may return. */
  limit: number;
  /** Scan timeout in milliseconds. */
  timeoutMs: number;
  /** This partition's slice of the entries (`pk % count === index`). */
  partition: { count: number; index: number };
}

/** Partial result returned by one worker, merged by the pool. */
export interface PartitionResult {
  results: SearchResult[];
  total: number;
  screened: number;
  partial: boolean;
}

// One connection + MoleculesDBSQLite per database file, reused across every scan
// this worker handles. Module scope lives for the worker's whole lifetime, so the
// heavy OpenChemLib load and the SQLite connection are paid once per worker.
const databases = new Map<string, MoleculesDBSQLite>();

/**
 * Run one partition of a substructure scan. Imported and invoked inside a
 * workerpool worker; never call it on the main thread.
 *
 * The SQLite connection is opened lazily (and only here) so this module stays
 * loadable in environments without `node:sqlite` — a future WebAssembly SQLite
 * build only needs to swap this one connection-opening step.
 * @param task - The partition descriptor.
 * @returns This partition's matches and scan metadata.
 */
export async function runSearchPartition(
  task: PartitionTask,
): Promise<PartitionResult> {
  let moleculesDB = databases.get(task.dbPath);
  if (!moleculesDB) {
    const { DatabaseSync } = await import('node:sqlite');
    const connection = new DatabaseSync(task.dbPath);
    connection.exec('PRAGMA busy_timeout=30000');
    moleculesDB = new MoleculesDBSQLite(connection, OCL, task.config);
    databases.set(task.dbPath, moleculesDB);
  }

  const response = await moleculesDB.search(task.query, {
    mode: 'substructure',
    format: task.format,
    from: 0,
    limit: task.limit,
    timeoutMs: task.timeoutMs,
    partition: task.partition,
    onProgress: (processed, total) =>
      workerEmit({
        type: 'progress',
        index: task.partition.index,
        processed,
        total,
      }),
  });

  return {
    results: response.results,
    total: response.total,
    screened: response.screened ?? 0,
    partial: response.partial ?? false,
  };
}
