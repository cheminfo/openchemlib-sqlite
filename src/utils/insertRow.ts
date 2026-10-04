import type { PrecomputedEntry } from '../types.ts';

import { callerName } from './indexColumns.ts';

/** The fingerprint columns of `ocl_ss_index`, in order. */
const WORDS =
  'ss_index0, ss_index1, ss_index2, ss_index3, ss_index4, ss_index5, ss_index6, ss_index7';

/** Where an inserted row takes its weight from, when it is not given. */
export interface WeightFromEntries {
  /** The entries table. */
  entriesTable: string;
  /** Its primary key. */
  pkColumn: string;
  /** Its column holding each entry's weight. */
  mwColumn: string;
}

/**
 * The statement writing one row of `ocl_ss_index`: its weight, its entry id,
 * its eight fingerprint words, then the carried columns.
 * @param columns - The carried columns, by SQL name, in the order they are bound.
 * @param weightFrom - Where to read the weight, when it is read from the
 *   entries table rather than bound; the entry id is then bound twice.
 * @returns SQL taking the weight (or the entry id), the entry id, the words and
 *   the columns' values.
 */
export function buildInsertSql(
  columns: readonly string[],
  weightFrom?: WeightFromEntries,
): string {
  const extra = columns.map((column) => `, ${column}`).join('');
  const placeholders = columns.map(() => ', ?').join('');
  const weight =
    weightFrom === undefined
      ? '?'
      : `(SELECT COALESCE(${weightFrom.mwColumn}, 0) FROM ${weightFrom.entriesTable} WHERE ${weightFrom.pkColumn} = ?)`;
  return `INSERT OR REPLACE INTO ocl_ss_index (mw, entry_id, ${WORDS}${extra})
          VALUES (${weight}, ?, ?, ?, ?, ?, ?, ?, ?, ?${placeholders})`;
}

/**
 * The values of the carried columns an insert binds, in order: what the
 * caller passed for each, or NULL.
 * @param columns - The carried columns, by SQL name.
 * @param given - The values the caller passed, by its names.
 * @returns The values.
 */
export function columnValues(
  columns: readonly string[],
  given: PrecomputedEntry['columns'],
): Array<number | null> {
  const values = new Array<number | null>(columns.length);
  for (let index = 0; index < columns.length; index++) {
    values[index] = given?.[callerName(columns[index] as string)] ?? null;
  }
  return values;
}
