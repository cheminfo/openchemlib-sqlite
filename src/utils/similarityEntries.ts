import type { SQLiteDatabase, SearchResult } from '../types.ts';

import type { EntryRestriction } from './restrictEntries.ts';
import { isScanDeadline } from './scanDeadline.ts';
import { rowToResult } from './searchHelpers.ts';

/** How many matches one statement reads the entries of. */
const LOOKUP_CHUNK = 500;

/** Where the entries of a similarity scan's matches are read. */
export interface MatchedEntriesParams {
  db: SQLiteDatabase;
  entriesTable: string;
  pkColumn: string;
  idCodeColumn: string;
  /** The caller's restriction: its candidates tested per entry apply here. */
  restriction: EntryRestriction;
}

/** A row the index alone let through: its entry and its coefficient. */
export interface IndexMatch {
  entryId: number;
  similarity: number;
}

/** The matches whose entry exists and passes the candidates test. */
export interface MatchedEntries {
  /** The matches, best first, ties by entry id. */
  results: Array<SearchResult & { similarity: number }>;
  /** Whether the deadline left some matches unread. */
  timedOut: boolean;
}

/**
 * Read the entries of the rows a similarity scan of the index alone let
 * through: their idCode, and whether they pass the candidates a caller tests
 * per entry. A row whose entry is not in the entries table — a view the
 * caller restricts, or an entry deleted since — is dropped, as a join would
 * have dropped it.
 *
 * The entries are read by primary key, a chunk of matches at a time, best
 * first: when the deadline cuts the reading short, the matches kept are the
 * most similar ones read.
 * @param params - The entries table, its columns and the restriction.
 * @param matches - The rows that reached the threshold, in any order.
 * @param deadline - When to stop, in ms since the epoch. The first chunk is
 *   always read.
 * @returns The matches with their entries.
 */
export function matchedEntries(
  params: MatchedEntriesParams,
  matches: readonly IndexMatch[],
  deadline: number,
): MatchedEntries {
  const { db, entriesTable, pkColumn, idCodeColumn, restriction } = params;
  const ordered = matches.toSorted(
    (a, b) => b.similarity - a.similarity || a.entryId - b.entryId,
  );
  const stmt = db.prepare(
    `SELECT e.${pkColumn} AS entry_id, e.${idCodeColumn} AS id_code
       FROM json_each(?) j CROSS JOIN ${entriesTable} e ON e.${pkColumn} = j.value
      WHERE 1${restriction.entryWhere}`,
  );
  // The candidates' named parameters only bind where their test is written.
  const named = restriction.entryWhere === '' ? [] : restriction.named;
  const results: Array<SearchResult & { similarity: number }> = [];
  for (let start = 0; start < ordered.length; start += LOOKUP_CHUNK) {
    if (start > 0 && Date.now() > deadline) {
      return { results, timedOut: true };
    }
    const end = Math.min(start + LOOKUP_CHUNK, ordered.length);
    const ids: number[] = [];
    for (let i = start; i < end; i++) ids.push(ordered[i]?.entryId ?? 0);
    const found = new Map<number, Record<string, unknown>>();
    const rows = stmt.all(...named, JSON.stringify(ids)) as Array<
      Record<string, unknown>
    >;
    for (const row of rows) found.set(Number(row.entry_id), row);
    for (let i = start; i < end; i++) {
      const match = ordered[i];
      const row = match === undefined ? undefined : found.get(match.entryId);
      if (match !== undefined && row !== undefined) {
        results.push({ ...rowToResult(row), similarity: match.similarity });
      }
    }
  }
  return { results, timedOut: false };
}

/**
 * The rows a scan statement yields until its end or its deadline.
 * @param db - The connection.
 * @param sql - The statement.
 * @param values - Its parameters.
 * @param deadline - When to stop, in ms since the epoch.
 * @returns The rows read, and whether the deadline stopped the reading.
 */
export function readMatches(
  db: SQLiteDatabase,
  sql: string,
  values: unknown[],
  deadline: number,
): { rows: Array<Record<string, unknown>>; timedOut: boolean } {
  const stmt = db.prepare(sql);
  const rows: Array<Record<string, unknown>> = [];
  try {
    const iterable = (stmt.iterate?.(...values) ??
      stmt.all(...values)) as Iterable<Record<string, unknown>>;
    for (const row of iterable) {
      rows.push(row);
      if (rows.length % 500 === 0 && Date.now() > deadline) {
        return { rows, timedOut: true };
      }
    }
  } catch (error: unknown) {
    if (!isScanDeadline(error)) throw error;
    return { rows, timedOut: true };
  }
  return { rows, timedOut: false };
}
