import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { strongHash } from 'openchemlib-search-wasm';

import { SEQ_SPAN } from '../chemistry/key.ts';

import type { RebuildPosition } from './rebuildState.ts';

/** Molecules whose idCode hash a step of the hash pass writes, in one short transaction. */
export const HASH_STEP = 4096;

/** A stored molecule, as the hash pass reads it. */
interface HashRow {
  id: bigint;
  idCode: string;
  idCodeHash: bigint;
}

/** The statements of the hash pass. */
export interface HashStatements {
  /** The molecules after an id, in id order. */
  after: StatementSync;
  /** The molecules of an id range. */
  range: StatementSync;
  /** The first id at or after an id. */
  first: StatementSync;
  update: StatementSync;
}

/**
 * Prepares the statements of the hash pass, once the column exists.
 * @param db - The connection.
 * @returns The statements.
 */
export function prepareHashStatements(db: DatabaseSync): HashStatements {
  const after = db.prepare(
    'SELECT id, idCode, idCodeHash FROM ocl_molecule WHERE id > ? ORDER BY id LIMIT ?',
  );
  after.setReadBigInts(true);
  const range = db.prepare(
    'SELECT id, idCode, idCodeHash FROM ocl_molecule WHERE id > ? AND id < ? ORDER BY id',
  );
  range.setReadBigInts(true);
  return {
    after,
    range,
    first: db.prepare(
      'SELECT id FROM ocl_molecule WHERE id >= ? ORDER BY id LIMIT 1',
    ),
    update: db.prepare('UPDATE ocl_molecule SET idCodeHash = ? WHERE id = ?'),
  };
}

/**
 * Reads the next step of the hash pass.
 * @param statements - The statements.
 * @param cursor - The last id done.
 * @returns The molecules, at most {@link HASH_STEP}.
 */
export function readHashStep(
  statements: HashStatements,
  cursor: number,
): HashRow[] {
  return statements.after.all(cursor, HASH_STEP) as unknown as HashRow[];
}

/**
 * Writes the idCode hash of molecules whose stored one differs: OCL's StrongHasher of the
 * canonical idCode, which no chemistry is needed for.
 * @param statements - The statements.
 * @param rows - The molecules.
 * @returns How many hashes were written.
 */
export function writeHashes(
  statements: HashStatements,
  rows: readonly HashRow[],
): number {
  let written = 0;
  for (const row of rows) {
    const hash = strongHash(row.idCode);
    if (hash === row.idCodeHash) continue;
    statements.update.run(hash, row.id);
    written++;
  }
  return written;
}

/**
 * Writes the idCode hash of every molecule committed since the hash pass began, which a build
 * without the column left at 0: those whose seq is above `hashFrom`, one seek per atom count.
 * @param statements - The statements.
 * @param hashFrom - The last seq when the pass began.
 * @returns How many hashes were written.
 */
export function hashNewRows(
  statements: HashStatements,
  hashFrom: number,
): number {
  let written = 0;
  for (let cursor = 0; ;) {
    const row = statements.first.get(cursor) as { id: number } | undefined;
    if (row === undefined) break;
    const base = Math.floor(row.id / SEQ_SPAN) * SEQ_SPAN;
    if (row.id - base > hashFrom) {
      const rows = statements.range.all(
        base + hashFrom,
        base + SEQ_SPAN,
      ) as unknown as HashRow[];
      written += writeHashes(statements, rows);
      cursor = base + SEQ_SPAN;
    } else {
      cursor = base + hashFrom + 1;
    }
  }
  return written;
}

/** What the hash pass needs from its run. */
export interface HashPassContext {
  statements: HashStatements;
  position: RebuildPosition;
  setMeta: StatementSync;
  /** Runs work in a write transaction of the rebuild. */
  write: (work: () => void) => void;
  /** Hears each step: the molecules walked by this call, and the hashes the step wrote. */
  report: (walked: number, written: number) => void;
  signal: AbortSignal | undefined;
}

/**
 * Writes the idCode hash of every stored molecule, in id order, a step per short write
 * transaction, unless an earlier run did; those committed meanwhile are hashed at the switch.
 * @param context - The run.
 */
export async function runHashPass(context: HashPassContext): Promise<void> {
  const { statements, position, setMeta, write, report, signal } = context;
  let walked = 0;
  while (!position.hashed) {
    signal?.throwIfAborted();
    const rows = readHashStep(statements, position.hashCursor);
    if (rows.length === 0) {
      write(() => setMeta.run('rebuild.hashed', 1));
      position.hashed = true;
      break;
    }
    const last = Number((rows.at(-1) as HashRow).id);
    let written = 0;
    write(() => {
      written = writeHashes(statements, rows);
      setMeta.run('rebuild.hashCursor', last);
    });
    position.hashCursor = last;
    walked += rows.length;
    report(walked, written);
    // eslint-disable-next-line no-await-in-loop -- the application's writers take the lock between steps
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
