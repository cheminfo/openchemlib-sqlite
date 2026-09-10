import { availableParallelism } from 'node:os';

import type {
  BackfillOptions,
  BackfillPassResult,
  BackfillResult,
  SQLiteDatabase,
} from '../types.ts';

import { StructureHashPool } from './StructureHashPool.ts';
import type { HashKind } from './structureHash.ts';
import { HASH_TABLE } from './structureHash.ts';

/** Everything the backfill needs to find the entries it still owes. */
export interface BackfillContext {
  db: SQLiteDatabase;
  entriesTable: string;
  pkColumn: string;
  idCodeColumn: string;
}

/* eslint-disable @typescript-eslint/naming-convention -- DB columns are snake_case */
interface PendingRow {
  entry_id: number;
  id_code: string | null;
}
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * The two hashes, in the order they are computed.
 *
 * The no-stereo hash goes first and is not a matter of taste: it costs ~74 µs a
 * molecule against ~22 ms for the tautomer one, roughly 300x, so running it
 * first means `exactNoStereo` is completely searchable in well under a minute
 * on a corpus where `exactNoStereoTautomer` is still hours from finishing.
 * Interleaving them would leave both modes half-answered for the whole run.
 */
const PASSES: HashKind[] = ['noStereo', 'noStereoTautomer'];

/**
 * Compute every hash that is missing, cheapest kind first.
 *
 * Resumable, because a row's presence in a hash table marks that entry hashed:
 * an interrupted run leaves every committed chunk in place and the next one
 * picks up exactly where it stopped. Nothing is ever recomputed, and a molecule
 * that was given up on is not retried — its NULL is an answer, not a gap.
 * @param context - The database and the entries table's columns.
 * @param options - Concurrency, the per-molecule cap, and progress reporting.
 * @returns One result per pass, plus the totals.
 */
export async function backfillHashes(
  context: BackfillContext,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const {
    poolSize = availableParallelism(),
    capMs = 100,
    chunkSize = 500,
    limit = Number.MAX_SAFE_INTEGER,
    onProgress,
    signal,
  } = options;

  const started = Date.now();
  const pool = new StructureHashPool(poolSize);
  const passes: BackfillPassResult[] = [];

  try {
    for (const kind of PASSES) {
      // Each pass runs to completion before the next starts, so the cheap hash
      // is finished and searchable while the expensive one is still going.
      // eslint-disable-next-line no-await-in-loop -- intentional: that ordering is the point
      const pass = await runPass(context, pool, kind, {
        capMs,
        chunkSize,
        limit,
        onProgress,
        signal,
      });
      passes.push(pass);
      if (signal?.aborted) break;
    }
  } finally {
    await pool.close();
  }

  return {
    passes,
    hashed: passes.reduce((sum, pass) => sum + pass.hashed, 0),
    noHash: passes.reduce((sum, pass) => sum + pass.noHash, 0),
    timedOut: passes.reduce((sum, pass) => sum + pass.timedOut, 0),
    remaining: passes.reduce((sum, pass) => sum + pass.remaining, 0),
    elapsedMs: Date.now() - started,
  };
}

/**
 * Fill one hash table for every entry that has no row in it yet.
 * @param context - The database and the entries table's columns.
 * @param pool - The worker pool doing the hashing.
 * @param kind - Which hash this pass computes.
 * @param options - The cap, chunking, bound, progress and abort signal.
 * @returns What this pass hashed, gave up on, and how long it took.
 */
async function runPass(
  context: BackfillContext,
  pool: StructureHashPool,
  kind: HashKind,
  options: Required<Pick<BackfillOptions, 'capMs' | 'chunkSize' | 'limit'>> &
    Pick<BackfillOptions, 'onProgress' | 'signal'>,
): Promise<BackfillPassResult> {
  const { capMs, chunkSize, limit, onProgress, signal } = options;
  const table = HASH_TABLE[kind];
  const total = countPending(context, table);
  const started = Date.now();
  const result: BackfillPassResult = {
    kind,
    hashed: 0,
    noHash: 0,
    timedOut: 0,
    remaining: total,
    elapsedMs: 0,
  };
  if (total === 0 || limit <= 0) return result;

  const insert = context.db.prepare(
    `INSERT OR REPLACE INTO ${table} (entry_id, hash) VALUES (?, ?)`,
  );
  // Entries are walked in ascending primary key, and the watermark carries the
  // last one seen from chunk to chunk. Without it every chunk would re-scan the
  // rows already written in this run, since they are only excluded by the same
  // NOT EXISTS that finds the pending ones.
  let watermark: number | null = null;
  let processed = 0;

  /* eslint-disable no-await-in-loop -- intentional: one chunk at a time is what
     makes the run resumable, bounded in memory, and able to release the write
     lock between chunks */
  while (processed < limit && !signal?.aborted) {
    const rows = selectPending(
      context,
      table,
      watermark,
      Math.min(chunkSize, limit - processed),
    );
    if (rows.length === 0) break;
    watermark = rows.at(-1)?.entry_id ?? watermark;

    // The whole chunk is hashed before anything is written, so the write lock is
    // held for the insert alone rather than for the canonization.
    const hashes = await Promise.all(
      rows.map(async (row) => {
        // An entry with no idCode has no hash, and needs no worker to say so.
        if (!row.id_code) return { hash: null, timedOut: false };
        return pool.hash(kind, row.id_code, capMs);
      }),
    );

    context.db.exec('BEGIN');
    try {
      for (let i = 0; i < rows.length; i++) {
        const hash = hashes[i]?.hash;
        // BigInt rather than the decimal string: the value is a signed 64-bit
        // integer and is bound as one, instead of leaving the conversion to
        // SQLite's column affinity.
        insert.run(
          rows[i]?.entry_id,
          hash === null || hash === undefined ? null : BigInt(hash),
        );
      }
      context.db.exec('COMMIT');
    } catch (error) {
      context.db.exec('ROLLBACK');
      throw error;
    }

    for (const outcome of hashes) {
      if (outcome.hash !== null) result.hashed++;
      else if (outcome.timedOut) result.timedOut++;
      else result.noHash++;
    }
    processed += rows.length;
    result.remaining = Math.max(0, total - processed);
    result.elapsedMs = Date.now() - started;
    onProgress?.({ ...result, done: processed, total });

    // Yield, so a caller running this beside a server keeps serving. The chunk
    // just committed, so the write lock is already released.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  /* eslint-enable no-await-in-loop */

  result.elapsedMs = Date.now() - started;
  return result;
}

/**
 * How many entries still have no row in a hash table.
 * @param context - The database and the entries table's columns.
 * @param table - The hash table to check against.
 * @returns The count.
 */
function countPending(context: BackfillContext, table: string): number {
  const { db, entriesTable, pkColumn } = context;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${entriesTable} e
       WHERE NOT EXISTS (SELECT 1 FROM ${table} h WHERE h.entry_id = e.${pkColumn})`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * The next entries owed a hash, in ascending primary key.
 * @param context - The database and the entries table's columns.
 * @param table - The hash table they are missing from.
 * @param after - Only entries past this primary key; null to start at the first.
 * @param limit - How many to return.
 * @returns Their primary keys and idCodes.
 */
function selectPending(
  context: BackfillContext,
  table: string,
  after: number | null,
  limit: number,
): PendingRow[] {
  const { db, entriesTable, pkColumn, idCodeColumn } = context;
  // The first chunk of a run has no watermark, and there is no primary key value
  // that is reliably below every other one — a negative key is legal — so the
  // clause is omitted rather than seeded with a sentinel.
  const afterClause = after === null ? '' : `AND e.${pkColumn} > ?`;
  const afterParams = after === null ? [] : [after];
  const rows = db
    .prepare(
      `SELECT e.${pkColumn} AS entry_id, e.${idCodeColumn} AS id_code
       FROM ${entriesTable} e
       WHERE NOT EXISTS (SELECT 1 FROM ${table} h WHERE h.entry_id = e.${pkColumn})
         ${afterClause}
       ORDER BY e.${pkColumn}
       LIMIT ?`,
    )
    .all(...afterParams, limit) as PendingRow[];
  // node:sqlite hands back null-prototype rows in dictionary mode; the plain
  // copies below are what the rest of this module reads.
  const pending = new Array<PendingRow>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    pending[i] = { ...(rows[i] as PendingRow) };
  }
  return pending;
}
