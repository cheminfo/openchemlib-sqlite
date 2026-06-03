import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import * as OCL from 'openchemlib';

import { MoleculesDBSQLite } from './MoleculesDBSQLite.ts';
import type { InputFormat, MoleculesDBConfig } from './types.ts';

/** Spawn-time data for a search worker. */
interface SearchWorkerData {
  dbPath: string;
  /** Column config only — no `dbPath`/`poolSize`, so the worker runs in-thread. */
  config: MoleculesDBConfig;
}

/** A partitioned substructure scan request. */
interface ScanRequest {
  id: number;
  query: string;
  format: InputFormat;
  limit: number;
  timeoutMs: number;
  partition: { count: number; index: number };
}

const port = parentPort;
if (!port) throw new Error('searchWorker must run as a worker thread');

const { dbPath, config } = workerData as SearchWorkerData;

// Each worker owns a private connection to the same database file and only ever
// reads from it (substructure search just screens fingerprints and matches
// structures). It is opened read-write rather than read-only because a read-only
// connection to a WAL database needs write access to the -shm file and can fail;
// read-write avoids that while still issuing no writes.
const connection = new DatabaseSync(dbPath);
connection.exec('PRAGMA busy_timeout=30000');
// `config` has no `dbPath`, so this instance runs the scan synchronously on this
// worker thread (no nested pool).
const moleculesDB = new MoleculesDBSQLite(connection, OCL, config);

port.on('message', (request: ScanRequest) => {
  moleculesDB
    .search(request.query, {
      mode: 'substructure',
      format: request.format,
      from: 0,
      limit: request.limit,
      timeoutMs: request.timeoutMs,
      partition: request.partition,
      onProgress: (processed, total) =>
        port.postMessage({
          type: 'progress',
          id: request.id,
          index: request.partition.index,
          processed,
          total,
        }),
    })
    .then((response) =>
      port.postMessage({
        type: 'done',
        id: request.id,
        results: response.results,
        total: response.total,
        screened: response.screened ?? 0,
        partial: response.partial ?? false,
      }),
    )
    .catch((error: unknown) =>
      port.postMessage({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
});
