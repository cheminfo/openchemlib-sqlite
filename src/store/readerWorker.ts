import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

/** A job for a reader. */
export type ReaderRequest =
  | {
      /** Matches the reply to the request. */
      id: number;
      /** The stored molecules carrying each no-stereo hash. */
      kind: 'same';
      hashes: BigInt64Array;
    }
  | {
      id: number;
      /** A seek in each hash index per molecule, whose rows are not needed. */
      kind: 'touch';
      noStereo: BigInt64Array;
      tautomer: BigInt64Array;
    }
  | {
      id: number;
      /** A statement run once per key, whose rows are not needed. */
      kind: 'read';
      sql: string;
      keys: SQLInputValue[];
    };

/** A stored molecule: its id and canonical idCode. */
export type StoredRow = [id: number, idCode: string];

if (parentPort !== null) {
  const port = parentPort;
  const { file } = workerData as { file: string };
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 30000');
  const answer = readerOf(db);
  port.on('message', (request: ReaderRequest) => {
    try {
      port.postMessage({ id: request.id, result: answer(request) });
    } catch (error) {
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * What a reader answers, through its connection's statements.
 * @param db - The read-only connection.
 * @returns For a job, the rows of each hash for `same`, else how many reads were made.
 */
function readerOf(
  db: DatabaseSync,
): (request: ReaderRequest) => StoredRow[][] | number {
  const same = db.prepare(
    'SELECT id, idCode FROM ocl_molecule WHERE noStereoHash = ?',
  );
  same.setReturnArrays(true);
  const noStereo = db.prepare(
    'SELECT id FROM ocl_molecule WHERE noStereoHash = ? LIMIT 1',
  );
  const tautomer = db.prepare(
    'SELECT id FROM ocl_molecule WHERE tautomerHash = ? LIMIT 1',
  );
  const statements = new Map<string, StatementSync>();
  return (request) => {
    switch (request.kind) {
      case 'same': {
        const rows = new Array<StoredRow[]>(request.hashes.length);
        for (let i = 0; i < request.hashes.length; i++) {
          rows[i] = same.all(
            request.hashes[i] as bigint,
          ) as unknown as StoredRow[];
        }
        return rows;
      }
      case 'touch': {
        for (const hash of request.noStereo) noStereo.get(hash);
        for (const hash of request.tautomer) tautomer.get(hash);
        return request.noStereo.length + request.tautomer.length;
      }
      case 'read': {
        let statement = statements.get(request.sql);
        if (statement === undefined) {
          statement = db.prepare(request.sql);
          statements.set(request.sql, statement);
        }
        for (const key of request.keys) statement.get(key);
        return request.keys.length;
      }
      // no default
    }
  };
}
