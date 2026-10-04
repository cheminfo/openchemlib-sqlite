import type {
  ColumnValues,
  FillColumnsOptions,
  FillColumnsResult,
  IndexColumnType,
  SQLiteDatabase,
} from '../types.ts';

import { COLUMNS_TABLE, callerName } from './indexColumns.ts';

/** Reads the values of the caller's columns for some entries. */
export type ColumnReader = (
  entryIds: readonly number[],
) => Iterable<ColumnValues>;

/** A column still to fill, as {@link COLUMNS_TABLE} records it. */
interface PendingColumn {
  /** Its SQL name. */
  name: string;
  fillTo: number;
  cursor: number;
}

/**
 * Fill the carried columns of the entries that were indexed before the
 * columns existed, a chunk of entries per transaction.
 *
 * The entries are walked in id order through the entry index, from the
 * lowest point any column has reached to the highest id any was added over;
 * each chunk is one short transaction, and the progress of every column is
 * recorded with it, so an interrupted run resumes where it stopped. The
 * values are read through `read`, and an entry it returns nothing for is
 * stored NULL. A column complete for every entry may be bounded from then on.
 * @param db - The database to fill.
 * @param declared - The caller's columns, by SQL name.
 * @param read - Reads the caller's values.
 * @param options - Chunk size, limit, progress and abort signal.
 * @returns What this call filled, and whether anything is still pending.
 */
export async function fillColumns(
  db: SQLiteDatabase,
  declared: ReadonlyMap<string, IndexColumnType>,
  read: ColumnReader,
  options: FillColumnsOptions = {},
): Promise<FillColumnsResult> {
  const {
    chunkSize = 5000,
    limit = Number.MAX_SAFE_INTEGER,
    onProgress,
    signal,
  } = options;
  const start = Date.now();
  let pending = pendingColumns(db).filter((column) =>
    declared.has(column.name),
  );

  const nextIds = db.prepare(
    `SELECT entry_id FROM ocl_ss_index INDEXED BY idx_ocl_ss_entry
      WHERE entry_id > ? AND entry_id <= ? ORDER BY entry_id LIMIT ?`,
  );
  const progress = db.prepare(
    `UPDATE ${COLUMNS_TABLE} SET fill_cursor = MAX(fill_cursor, ?) WHERE name = ?`,
  );
  const complete = db.prepare(
    `UPDATE ${COLUMNS_TABLE} SET fill_to = NULL WHERE name = ? AND fill_cursor >= fill_to`,
  );
  let filled = 0;

  while (pending.length > 0 && filled < limit && signal?.aborted !== true) {
    const from = Math.min(...pending.map((column) => column.cursor));
    const to = Math.max(...pending.map((column) => column.fillTo));
    const ids = (
      nextIds.all(from, to, Math.min(chunkSize, limit - filled)) as Array<
        Record<string, unknown>
      >
    ).map((row) => Number(row.entry_id));
    const last = ids.at(-1) ?? to;

    const names = pending.map((column) => column.name);
    const update = db.prepare(
      `UPDATE ocl_ss_index SET ${names.map((name) => `${name} = ?`).join(', ')}
        WHERE entry_id = ?`,
    );
    const values = new Map<number, ColumnValues['columns']>();
    if (ids.length > 0) {
      for (const entry of read(ids)) values.set(entry.entryId, entry.columns);
    }

    db.exec('BEGIN');
    try {
      for (const id of ids) {
        const own = values.get(id);
        update.run(...names.map((name) => own?.[callerName(name)] ?? null), id);
      }
      for (const name of names) {
        progress.run(ids.length === 0 ? to : last, name);
        complete.run(name);
      }
      db.exec('COMMIT');
    } catch (error: unknown) {
      db.exec('ROLLBACK');
      throw error;
    }
    filled += ids.length;
    onProgress?.(filled);
    pending = pendingColumns(db).filter((column) =>
      names.includes(column.name),
    );
    // Between chunks, so a run never holds the write lock for long.
    // eslint-disable-next-line no-await-in-loop -- intentional: yield between chunks
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  return {
    filled,
    pending: pendingColumns(db).length > 0,
    elapsedMs: Date.now() - start,
  };
}

/**
 * The columns not yet filled for every entry.
 * @param db - The database to read.
 * @returns Them, with how far each has come.
 */
function pendingColumns(db: SQLiteDatabase): PendingColumn[] {
  return (
    db
      .prepare(
        `SELECT name, fill_to, fill_cursor FROM ${COLUMNS_TABLE}
          WHERE fill_to IS NOT NULL`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({
    name: String(row.name),
    fillTo: Number(row.fill_to),
    cursor: Number(row.fill_cursor),
  }));
}
