import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { WriteStatements } from './commit.ts';
import { commitRecords, prepareWriteStatements } from './commit.ts';
import type { StoreParts } from './openStore.ts';
import { removeMolecules } from './remove.ts';
import { checkWritable } from './writeState.ts';

/** What a migration did so far. */
export interface V5Counts {
  /** Entries converted: read in the first pass, or again after a change. */
  entries: number;
  /** Molecules added to the store. */
  created: number;
  /** Entries whose idCode the store could not take. */
  failed: number;
}

/** One entry as the application's table holds it now. */
export interface EntryRow {
  entry: number;
  idCode: string | null;
}

/** Commits the molecules of 5.x entries and keeps the id each entry got. */
export class V5Converter {
  readonly #db: DatabaseSync;
  readonly #parts: StoreParts;
  readonly #write: WriteStatements;
  readonly #idOf: StatementSync;
  readonly #setId: StatementSync;
  readonly #deleteId: StatementSync;
  readonly #isUsed: StatementSync;
  readonly counts: V5Counts = { entries: 0, created: 0, failed: 0 };

  /**
   * A converter writing through the store's parts.
   * @param db - The connection.
   * @param parts - The store's parts: its chemistry workers and its write state.
   */
  constructor(db: DatabaseSync, parts: StoreParts) {
    this.#db = db;
    this.#parts = parts;
    this.#write = prepareWriteStatements(db);
    this.#idOf = db.prepare('SELECT id FROM ocl_v5_ids WHERE entry = ?');
    this.#setId = db.prepare(
      'INSERT OR REPLACE INTO ocl_v5_ids (entry, id, error) VALUES (?, ?, ?)',
    );
    this.#deleteId = db.prepare('DELETE FROM ocl_v5_ids WHERE entry = ?');
    this.#isUsed = db.prepare('SELECT 1 AS used FROM ocl_v5_ids WHERE id = ?');
  }

  /**
   * Commits the molecules of some entries and writes their ids, forgets removed entries, and drops
   * the molecules no entry holds any more, in one write transaction with `then`.
   * @param rows - The entries to convert, with their current idCode.
   * @param removed - The entries gone from the application's table.
   * @param then - What the transaction records besides: the position, or the changes taken.
   */
  async convert(
    rows: readonly EntryRow[],
    removed: readonly number[],
    then: () => void,
  ): Promise<void> {
    const taken = rows.filter((row) => typeof row.idCode === 'string');
    const records =
      taken.length === 0
        ? null
        : await this.#parts.pool.records(
            taken.map((row) => row.idCode as string),
          );
    writeTransaction(this.#db, () => {
      const left = new Set<number>();
      if (records !== null) {
        const committed = commitRecords(this.#db, this.#write, records, () =>
          this.#writable(),
        );
        for (const [i, row] of taken.entries()) {
          const result = committed[i];
          const error = result === undefined ? (records.errors[i] ?? '') : null;
          this.#replace(row.entry, result?.id ?? null, error, left);
          if (result === undefined) this.counts.failed++;
          else if (result.created) this.counts.created++;
        }
      }
      for (const row of rows) {
        if (typeof row.idCode === 'string') continue;
        this.#replace(row.entry, null, 'no idCode', left);
        this.counts.failed++;
      }
      for (const entry of removed) {
        const old = this.#idOf.get(entry) as { id: number | null } | undefined;
        this.#deleteId.run(entry);
        if (old?.id != null) left.add(old.id);
      }
      this.#removeUnused(left);
      then();
    });
    this.counts.entries += rows.length + removed.length;
  }

  #replace(
    entry: number,
    id: number | null,
    error: string | null,
    left: Set<number>,
  ): void {
    const old = this.#idOf.get(entry) as { id: number | null } | undefined;
    this.#setId.run(entry, id, error);
    if (old?.id != null && old.id !== id) left.add(old.id);
  }

  /**
   * Removes the molecules no entry holds any more, as 5.x forgot an entry once it was removed.
   * @param candidates - The molecules an entry stopped holding.
   */
  #removeUnused(candidates: ReadonlySet<number>): void {
    const unused: number[] = [];
    for (const id of candidates) {
      if (this.#isUsed.get(id) === undefined) unused.push(id);
    }
    if (unused.length > 0) {
      removeMolecules(this.#db, unused, () => this.#writable());
    }
  }

  #writable() {
    const { state, stamp, signatures } = this.#parts;
    return checkWritable(this.#db, state, stamp, signatures);
  }
}

/**
 * Runs some work in a write transaction, rolled back when it throws.
 * @param db - The connection, outside any transaction.
 * @param work - The work.
 */
export function writeTransaction(db: DatabaseSync, work: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
