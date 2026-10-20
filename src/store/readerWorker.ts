import type { SQLInputValue, StatementSync } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

/** A job for a reader. */
export type ReaderRequest =
  | {
      /** Matches the reply to the request. */
      id: number;
      /** The stored molecule of each idCode, sought by the hash of that idCode. */
      kind: 'exact';
      hashes: BigInt64Array;
      idCodes: string[];
    }
  | {
      id: number;
      /** Whether a stored molecule carries each no-stereo hash. */
      kind: 'family';
      hashes: BigInt64Array;
    }
  | {
      id: number;
      /** A seek in each hash index per molecule, whose rows are not needed. */
      kind: 'touch';
      noStereo: BigInt64Array;
      tautomer: BigInt64Array;
      idCode: BigInt64Array;
    }
  | {
      id: number;
      /** A statement run once per key, whose rows are not needed. */
      kind: 'read';
      sql: string;
      keys: SQLInputValue[];
    };

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
 * @returns For a job: each idCode's stored id (-1 for none) for `exact`, whether each hash is
 * stored (1 or 0) for `family`, else how many reads were made.
 */
function readerOf(
  db: DatabaseSync,
): (request: ReaderRequest) => Float64Array | Uint8Array | number {
  const exact = db.prepare(
    'SELECT id, idCode FROM ocl_molecule WHERE idCodeHash = ?',
  );
  const noStereo = db.prepare(
    'SELECT id FROM ocl_molecule WHERE noStereoHash = ? LIMIT 1',
  );
  const tautomer = db.prepare(
    'SELECT id FROM ocl_molecule WHERE tautomerHash = ? LIMIT 1',
  );
  const idCode = db.prepare(
    'SELECT id FROM ocl_molecule WHERE idCodeHash = ? LIMIT 1',
  );
  const statements = new Map<string, StatementSync>();
  return (request) => {
    switch (request.kind) {
      case 'exact': {
        const ids = new Float64Array(request.hashes.length).fill(-1);
        for (let i = 0; i < request.hashes.length; i++) {
          // A hash may be shared by two idCodes: the idCode itself decides.
          for (const row of exact.iterate(request.hashes[i] as bigint)) {
            const { id, idCode: stored } = row as {
              id: number;
              idCode: string;
            };
            if (stored === request.idCodes[i]) {
              ids[i] = id;
              break;
            }
          }
        }
        return ids;
      }
      case 'family': {
        const stored = new Uint8Array(request.hashes.length);
        for (let i = 0; i < request.hashes.length; i++) {
          stored[i] =
            noStereo.get(request.hashes[i] as bigint) === undefined ? 0 : 1;
        }
        return stored;
      }
      case 'touch': {
        for (const hash of request.noStereo) noStereo.get(hash);
        for (const hash of request.tautomer) tautomer.get(hash);
        for (const hash of request.idCode) idCode.get(hash);
        return (
          request.noStereo.length +
          request.tautomer.length +
          request.idCode.length
        );
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
