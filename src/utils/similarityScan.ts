import type * as OpenChemLib from 'openchemlib';

import type { SQLiteDatabase, ScanPosition, SearchResult } from '../types.ts';

import { carriesBits } from './bitsColumn.ts';
import { indexBits } from './fingerprintBits.ts';
import { BITS_COLUMN } from './indexColumns.ts';
import { unpackSSIndex } from './packSSIndex.ts';
import type { EntryRestriction } from './restrictEntries.ts';
import {
  installScanDeadline,
  isScanDeadline,
  scanDeadlineGuard,
} from './scanDeadline.ts';
import { rowToResult } from './searchHelpers.ts';
import {
  installTanimoto,
  tanimotoSql,
  withTanimotoQuery,
} from './tanimotoFunction.ts';

type OCLLibrary = typeof OpenChemLib;

/** A cached full (unsliced) structure-scan result, paginated on each hit. */
export interface CachedScan {
  results: SearchResult[];
  screened: number;
  matched: number;
  partial: boolean;
  elapsedMs: number;
  timedOut: boolean;
  resume?: ScanPosition;
}

/** What a similarity scan reads, and against what. */
export interface SimilarityScanParams {
  db: SQLiteDatabase;
  ocl: OCLLibrary;
  entriesTable: string;
  pkColumn: string;
  idCodeColumn: string;
  /** The query's fingerprint, as `Molecule.getIndex()` returns it. */
  queryIndex: number[];
  /** The coefficient a match reaches. */
  threshold: number;
  timeoutMs: number;
  /** The caller's candidates, weight range and column bounds, as SQL. */
  restriction: EntryRestriction;
}

/** The bit counts a row may have and still reach a threshold, inclusive. */
export interface BitWindow {
  low: number;
  high: number;
}

/**
 * The bit counts an entry may have and still reach a Tanimoto coefficient of
 * `threshold` with a query setting `bits` bits.
 *
 * The coefficient is the bits both set over the bits either sets. The first
 * is at most the smaller count, the second at least the larger, so it never
 * exceeds the ratio of the two counts: reaching `t` needs `t·|q| ≤ |r| ≤
 * |q|/t`. The window is widened by a hair on either side so that rounding
 * never excludes an entry that ties the threshold exactly.
 * @param bits - How many bits the query sets.
 * @param threshold - The coefficient a match reaches.
 * @returns The window, or null when the threshold excludes no count.
 */
export function bitWindow(bits: number, threshold: number): BitWindow | null {
  if (!(threshold > 0)) return null;
  return {
    low: Math.max(0, Math.ceil(threshold * bits - 1e-9)),
    high: Math.floor(bits / threshold + 1e-9),
  };
}

/**
 * Run a full similarity scan (no pagination): Tanimoto over every indexed row.
 *
 * The coefficient is computed inside SQLite and the threshold tested there,
 * so only the entries that reach it are handed to JavaScript: handing every
 * row over — ten columns, eight of them BigInts — was most of the scan's cost.
 * Each row's stored bit count is compared with the window the threshold allows
 * first, so a row that cannot reach it is rejected by one comparison rather
 * than a call computing its coefficient. A row whose count is not known —
 * indexed before the count was stored and not filled since, or written by the
 * caller's own SQL — is always computed.
 * The guard stops a step that reads without yielding at the deadline.
 * @param params - The query, its threshold and its restriction.
 * @returns The scan.
 */
export function scanSimilarity(params: SimilarityScanParams): CachedScan {
  const { db, queryIndex, threshold, timeoutMs, restriction } = params;
  const { entriesTable, pkColumn, idCodeColumn } = params;
  const start = Date.now();
  const deadline = start + timeoutMs;
  if (!installTanimoto(db)) return scanSimilarityInJs(params, deadline);
  const guarded = installScanDeadline(db);
  const window = carriesBits(db)
    ? bitWindow(indexBits(queryIndex), threshold)
    : null;
  // A count that is not known is never a reason to skip the entry.
  const windowSql =
    window === null
      ? ''
      : ` AND (s.${BITS_COLUMN} IS NULL OR s.${BITS_COLUMN} BETWEEN ? AND ?)`;
  return withTanimotoQuery(queryIndex, (key) => {
    const stmt = db.prepare(
      `SELECT e.${pkColumn} AS entry_id, e.${idCodeColumn} AS id_code,
              ${tanimotoSql('s')} AS similarity
         FROM ${entriesTable} e
         JOIN ocl_ss_index s ON s.entry_id = e.${pkColumn} ${restriction.join}
        WHERE ${guarded ? scanDeadlineGuard('s.entry_id') : '1'}${windowSql}${restriction.where}
          AND similarity >= ?`,
    );
    const values = [
      ...restriction.named,
      key,
      ...(guarded ? [deadline] : []),
      ...(window === null ? [] : [window.low, window.high]),
      ...restriction.values,
      threshold,
    ];
    const withSim: Array<SearchResult & { similarity: number }> = [];
    let timedOut = false;
    try {
      const rows = (stmt.iterate?.(...values) ??
        stmt.all(...values)) as Iterable<Record<string, unknown>>;
      for (const row of rows) {
        withSim.push({
          ...rowToResult(row),
          similarity: row.similarity as number,
        });
        if (withSim.length % 500 === 0 && Date.now() > deadline) {
          timedOut = true;
          break;
        }
      }
    } catch (error: unknown) {
      if (!isScanDeadline(error)) throw error;
      timedOut = true;
    }
    return similarityScan(withSim, timedOut, start);
  });
}

/**
 * The same scan for a driver that cannot register a function: every row is
 * read and its coefficient computed here.
 * @param params - The query, its threshold and its restriction.
 * @param deadline - When to stop, in ms since the epoch.
 * @returns The scan.
 */
function scanSimilarityInJs(
  params: SimilarityScanParams,
  deadline: number,
): CachedScan {
  const { db, ocl, queryIndex, threshold, restriction } = params;
  const { entriesTable, pkColumn, idCodeColumn } = params;
  const start = Date.now();
  const stmt = db.prepare(
    `SELECT e.${pkColumn} AS entry_id, e.${idCodeColumn} AS id_code,
            s.ss_index0, s.ss_index1, s.ss_index2, s.ss_index3,
            s.ss_index4, s.ss_index5, s.ss_index6, s.ss_index7
       FROM ${entriesTable} e
       JOIN ocl_ss_index s ON s.entry_id = e.${pkColumn} ${restriction.join}
      WHERE 1${restriction.where}`,
  );
  stmt.setReadBigInts?.(true);
  const values = [...restriction.named, ...restriction.values];
  const rows = (stmt.iterate?.(...values) ?? stmt.all(...values)) as Iterable<
    Record<string, unknown>
  >;
  const withSim: Array<SearchResult & { similarity: number }> = [];
  let timedOut = false;
  let screened = 0;
  for (const row of rows) {
    screened++;
    const similarity = ocl.SSSearcherWithIndex.getSimilarityTanimoto(
      queryIndex,
      unpackSSIndex(row),
    );
    if (similarity >= threshold) {
      withSim.push({ ...rowToResult(row), similarity });
    }
    if (screened % 500 === 0 && Date.now() > deadline) {
      timedOut = true;
      break;
    }
  }
  return similarityScan(withSim, timedOut, start);
}

/**
 * A similarity scan's matches, best first, as the cache keeps them.
 * @param withSim - The entries that reached the threshold, in scan order.
 * @param timedOut - Whether the deadline stopped the scan.
 * @param start - When it started, in ms since the epoch.
 * @returns The scan.
 */
function similarityScan(
  withSim: Array<SearchResult & { similarity: number }>,
  timedOut: boolean,
  start: number,
): CachedScan {
  // Ties are broken by entry id, so the order never depends on the plan the
  // scan happened to take.
  const results = withSim.toSorted(
    (a, b) => b.similarity - a.similarity || a.entryId - b.entryId,
  );
  return {
    results,
    screened: results.length,
    matched: results.length,
    partial: timedOut,
    timedOut,
    elapsedMs: Date.now() - start,
  };
}
