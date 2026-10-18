import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { EntryRow, V5Converter } from './migrateV5Convert.ts';
import { writeTransaction } from './migrateV5Convert.ts';
import type { V5Entries } from './v5Schema.ts';
import { V5_TRIGGERS, quoteName } from './v5Schema.ts';

/** Changes one catch-up round takes. */
const ROUND_CHANGES = 4096;

/** One run of a migration from 5.x: its first pass, its catch-up rounds and its end. */
export class V5Run {
  readonly #db: DatabaseSync;
  readonly #converter: V5Converter;
  readonly #readEntries: StatementSync;
  readonly #readEntry: StatementSync;
  readonly #readChanges: StatementSync;
  readonly #meta: StatementSync;
  readonly #setMeta: StatementSync;
  readonly #report: () => void;

  /**
   * A run over a file whose migration has begun.
   * @param db - The connection.
   * @param converter - What commits the entries' molecules.
   * @param entries - The application's table.
   * @param report - Called after each step.
   */
  constructor(
    db: DatabaseSync,
    converter: V5Converter,
    entries: V5Entries,
    report: () => void,
  ) {
    const table = quoteName(entries.table);
    const key = quoteName(entries.key);
    const idCode = quoteName(entries.idCode);
    this.#db = db;
    this.#converter = converter;
    this.#readEntries = db.prepare(
      `SELECT ${key} AS entry, ${idCode} AS idCode FROM ${table} WHERE ${key} > ? ORDER BY ${key} LIMIT ?`,
    );
    this.#readEntry = db.prepare(
      `SELECT ${idCode} AS idCode FROM ${table} WHERE ${key} = ?`,
    );
    this.#readChanges = db.prepare(
      'SELECT seq, entry FROM ocl_v5_changes ORDER BY seq LIMIT ?',
    );
    this.#meta = db.prepare('SELECT value FROM ocl_meta WHERE name = ?');
    this.#setMeta = db.prepare(
      'INSERT OR REPLACE INTO ocl_meta (name, value) VALUES (?, ?)',
    );
    this.#report = report;
  }

  /**
   * Converts every entry once, in key order, a chunk per write transaction, unless an earlier run
   * did; the position is kept in the same transaction, so a run that stops is continued.
   * @param chunkSize - Entries per chunk.
   * @param signal - Stops it between chunks.
   */
  async firstPass(
    chunkSize: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    while (this.#number('v5.scanned') !== 1) {
      signal?.throwIfAborted();
      const rows = this.#readEntries.all(
        this.#number('v5.cursor'),
        chunkSize,
      ) as unknown as EntryRow[];
      const last = rows.at(-1);
      if (last === undefined) {
        writeTransaction(this.#db, () => this.#setMeta.run('v5.scanned', 1));
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- each chunk is written before the next is read
      await this.#converter.convert(rows, [], () => {
        this.#setMeta.run('v5.cursor', last.entry);
      });
      this.#report();
    }
  }

  /**
   * Converts again the entries the 5.x writers changed, a round at a time, until at most `left`
   * changes remain.
   * @param left - The changes left for a later call.
   * @param signal - Stops it between rounds.
   * @returns How many changes remain.
   */
  async catchUp(
    left: number,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    let pending = this.pending();
    while (pending > left) {
      signal?.throwIfAborted();
      // eslint-disable-next-line no-await-in-loop -- each round is written before the next is read
      await this.#round();
      this.#report();
      pending = this.pending();
    }
    return pending;
  }

  /**
   * Ends the migration once nothing is logged: removes the triggers and the log, and marks the file
   * migrated, in one transaction. A change logged meanwhile is caught up first.
   * @param signal - Stops it between rounds.
   */
  async finish(signal: AbortSignal | undefined): Promise<void> {
    if (this.#number('v5.scanned') !== 1) {
      throw new Error(
        'the entries are not all converted yet: let migrateFromV5() read them to the end first',
      );
    }
    for (let done = false; !done;) {
      // eslint-disable-next-line no-await-in-loop -- the switch waits for an empty log
      await this.catchUp(0, signal);
      writeTransaction(this.#db, () => {
        if (this.pending() > 0) return;
        for (const trigger of V5_TRIGGERS) {
          this.#db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
        }
        this.#db.exec('DROP TABLE ocl_v5_changes');
        this.#setMeta.run('v5.state', 'migrated');
        this.#db.exec(
          "DELETE FROM ocl_meta WHERE name IN ('v5.cursor', 'v5.scanned')",
        );
        done = true;
      });
    }
  }

  /**
   * How many changes the log holds: 0 once the migration ended.
   * @returns The span of its sequence numbers.
   */
  pending(): number {
    const logged = this.#db
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE name = 'ocl_v5_changes'",
      )
      .get();
    if (logged === undefined) return 0;
    const span = this.#db
      .prepare('SELECT max(seq) - min(seq) + 1 AS n FROM ocl_v5_changes')
      .get() as { n: number | null };
    return span.n ?? 0;
  }

  async #round(): Promise<void> {
    const changes = this.#readChanges.all(ROUND_CHANGES) as Array<{
      seq: number;
      entry: number;
    }>;
    const upTo = changes.at(-1)?.seq;
    if (upTo === undefined) return;
    const rows: EntryRow[] = [];
    const removed: number[] = [];
    for (const entry of new Set(changes.map((change) => change.entry))) {
      const row = this.#readEntry.get(entry) as
        { idCode: string | null } | undefined;
      if (row === undefined) removed.push(entry);
      else rows.push({ entry, idCode: row.idCode });
    }
    await this.#converter.convert(rows, removed, () => {
      this.#db.prepare('DELETE FROM ocl_v5_changes WHERE seq <= ?').run(upTo);
    });
  }

  #number(name: string): number {
    const row = this.#meta.get(name) as { value: number } | undefined;
    return row === undefined ? Number.MIN_SAFE_INTEGER : row.value;
  }
}
