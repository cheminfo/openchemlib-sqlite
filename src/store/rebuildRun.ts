import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { FingerprintNeed } from '../chemistry/records.ts';
import type { Signatures } from '../chemistry/stamp.ts';

import type { Counting } from './bitCounts.ts';
import type { ChemistryPool } from './chemistryPool.ts';
import type { RoundContext } from './rebuildCatchUp.ts';
import { catchUpRound, finalRounds } from './rebuildCatchUp.ts';
import type { HashStatements } from './rebuildHashes.ts';
import {
  hashNewRows,
  prepareHashStatements,
  runHashPass,
} from './rebuildHashes.ts';
import {
  firstPassTiles,
  readFirstPassStep,
  writeFirstPassStep,
} from './rebuildPass.ts';
import type { RebuildPlan, RebuildPosition } from './rebuildState.ts';
import { checkToken, finishRebuild, prepareSetMeta } from './rebuildState.ts';
import type { RebuildStatements } from './rebuildStatements.ts';
import { pending, prepareStatements, read } from './rebuildStatements.ts';
import type { RebuildProgress } from './rebuildTypes.ts';

/** Log rows left when the switch takes them, under the write lock. */
const FINAL_CHANGES = 512;

/** One run of a rebuild: its hash pass, its first pass, its catch-up rounds and its switch. */
export class RebuildRun {
  readonly #db: DatabaseSync;
  /** The statements of the new tiles and counts; null when neither is rebuilt. */
  readonly #tiles: RebuildStatements | null;
  /** The statements of the idCode hashes; null when they are current. */
  readonly #hashes: HashStatements | null;
  readonly #token: StatementSync;
  readonly #setMeta: StatementSync;
  readonly #position: RebuildPosition;
  readonly #counting: Counting;
  readonly #need: FingerprintNeed;
  readonly #chemistry: boolean;
  readonly #total: number;
  readonly #listener: ((progress: RebuildProgress) => void) | undefined;
  /** Molecules this run went through. */
  molecules = 0;
  /** idCode hashes this run wrote. */
  hashed = 0;

  /**
   * A run of a rebuild begun or taken over.
   * @param db - Its connection.
   * @param position - Where the rebuild is.
   * @param work - What it does.
   * @param work.counting - The fingerprints it counts.
   * @param work.need - The fingerprints it computes.
   * @param work.tiles - Whether it builds new tiles and counts.
   * @param work.hashes - Whether it writes the idCode hashes.
   * @param progress - `total`, the molecules the file held, and `listener`, hearing each step.
   * @param progress.total - The molecules the file held.
   * @param progress.listener - Hears each step.
   */
  constructor(
    db: DatabaseSync,
    position: RebuildPosition,
    work: {
      counting: Counting;
      need: FingerprintNeed;
      tiles: boolean;
      hashes: boolean;
    },
    progress: {
      total: number;
      listener: ((progress: RebuildProgress) => void) | undefined;
    },
  ) {
    const { counting, need, tiles, hashes } = work;
    this.#db = db;
    this.#tiles = tiles ? prepareStatements(db) : null;
    this.#hashes = hashes ? prepareHashStatements(db) : null;
    this.#token = db.prepare(
      "SELECT value FROM ocl_meta WHERE name = 'rebuild.token'",
    );
    this.#setMeta = prepareSetMeta(db);
    this.#position = position;
    this.#counting = counting;
    this.#need = need;
    this.#chemistry = need.fragFp || need.screen || need.functions;
    this.#total = progress.total;
    this.#listener = progress.listener;
  }

  /**
   * Writes the idCode hash of every stored molecule, in id order, a step at a time, unless an
   * earlier run did; those committed meanwhile are hashed at the switch.
   * @param signal - Stops it between steps.
   */
  async hashPass(signal: AbortSignal | undefined): Promise<void> {
    if (this.#hashes === null) return;
    await runHashPass({
      statements: this.#hashes,
      position: this.#position,
      setMeta: this.#setMeta,
      write: (work) => this.#write(work),
      report: (walked, written) => {
        this.hashed += written;
        this.#listener?.({
          step: 'idCodeHash',
          molecules: walked,
          total: this.#total,
        });
      },
      signal,
    });
  }

  /**
   * Builds the new tile of every tile in use, a step at a time, unless an earlier run did.
   * @param pool - The chemistry workers.
   * @param tilesPerStep - Tiles per step.
   * @param signal - Stops it between steps.
   */
  async firstPass(
    pool: ChemistryPool,
    tilesPerStep: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const statements = this.#tiles;
    const position = this.#position;
    if (statements === null) return;
    while (!position.scanned) {
      signal?.throwIfAborted();
      const step = read(this.#db, () =>
        readFirstPassStep(
          statements,
          position.cursor,
          tilesPerStep,
          this.#chemistry,
        ),
      );
      if (step.keys.length === 0) {
        this.#write(() => statements.setMeta.run('rebuild.scanned', 1));
        position.scanned = true;
        break;
      }
      const computed = this.#chemistry
        ? // eslint-disable-next-line no-await-in-loop -- each step is written before the next is read
          await pool.fingerprints(step.idCodes, this.#need)
        : null;
      const update = firstPassTiles(
        step.keys,
        step.tiles,
        computed,
        this.#need,
      );
      position.cursor = step.keys.at(-1) as number;
      const done = position.done + update.molecules;
      this.#write(() =>
        writeFirstPassStep(statements, update, this.#counting, {
          cursor: position.cursor,
          done,
        }),
      );
      this.#report(update.molecules);
    }
  }

  /**
   * Brings the new tiles up to date from the log of changes, a round at a time, until little of
   * it is left.
   * @param pool - The chemistry workers.
   * @param signal - Stops it between rounds.
   */
  async catchUp(
    pool: ChemistryPool,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const tiles = this.#tiles;
    if (tiles === null) return;
    const context = this.#roundContext(tiles);
    const write = (work: () => void) => this.#write(work);
    while (pending(tiles) > FINAL_CHANGES) {
      signal?.throwIfAborted();
      // eslint-disable-next-line no-await-in-loop -- each round is written before the next is read
      if (!(await catchUpRound(context, this.#db, pool, write))) return;
    }
  }

  /**
   * The last rounds, the idCode hashes of the molecules committed during the hash pass, and the
   * switch, in one write transaction: no write lands between them.
   * @param plan - What is rebuilt.
   * @param to - This build's stamp and signatures.
   * @param to.stamp - The stamp.
   * @param to.signatures - The signatures.
   */
  switchOver(
    plan: RebuildPlan,
    to: { stamp: string; signatures: Signatures },
  ): void {
    const tiles = this.#tiles;
    const hashes = this.#hashes;
    this.#write(() => {
      if (tiles !== null) finalRounds(this.#roundContext(tiles));
      if (hashes !== null) {
        this.hashed += hashNewRows(hashes, this.#position.hashFrom);
      }
      finishRebuild(this.#db, plan, to);
    });
  }

  #roundContext(tiles: RebuildStatements): RoundContext {
    return {
      tiles,
      need: this.#need,
      counting: this.#counting,
      done: () => this.#position.done,
      report: (molecules) => this.#report(molecules),
    };
  }

  #write(work: () => void): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      checkToken(this.#token, this.#position.token);
      work();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #report(molecules: number): void {
    this.molecules += molecules;
    this.#position.done += molecules;
    this.#listener?.({
      step: 'tiles',
      molecules: this.#position.done,
      total: this.#total,
    });
  }
}
