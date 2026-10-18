/* eslint-disable no-await-in-loop -- each page continues the previous one */
import type { DatabaseSync } from 'node:sqlite';

import {
  getIndexes,
  getScreens,
  substructureSearch,
} from 'openchemlib-search-wasm';

import { popcount32 } from '../chemistry/bits.ts';
import type { MoleculeIndex } from '../search/MoleculeIndex.ts';
import type { SimilarityFingerprint } from '../search/fingerprint.ts';
import type { KeyPage, SearchOptions } from '../search/pages.ts';
import type { KeyCursor } from '../search/walk/walkPage.ts';

/** One molecule as SQL says it is. */
export interface TruthRow {
  id: number;
  idCode: string;
  key: number;
  logP: number | null;
  hba: number | null;
  charge: number | null;
  listed: boolean;
  sources: Set<number>;
}

/**
 * Every molecule with its application row, from SQL alone, sorted by (key, id).
 * @param db - The test database.
 * @returns The rows.
 */
export function readTruth(db: DatabaseSync): TruthRow[] {
  const rows = (
    db
      .prepare(
        'SELECT o.id AS id, o.idCode AS idCode, m.weight AS key, m.logP AS logP, m.hba AS hba, m.charge AS charge, m.listed AS listed FROM ocl_molecule o JOIN molecules m ON m.id = o.id',
      )
      .all() as Array<Omit<TruthRow, 'listed' | 'sources'> & { listed: number }>
  ).map((row) => ({
    ...row,
    listed: row.listed === 1,
    sources: new Set<number>(),
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const { sourceId, moleculeId } of db
    .prepare('SELECT sourceId, moleculeId FROM molecule_sources')
    .all() as Array<{
    sourceId: number;
    moleculeId: number;
  }>) {
    byId.get(moleculeId)?.sources.add(sourceId);
  }
  return rows.toSorted((a, b) => a.key - b.key || a.id - b.id);
}

/**
 * Whether a row passes a search's restriction, filters and key bounds, on exact values.
 * @param row - The row.
 * @param options - The search's options.
 * @returns True when the index must answer it.
 */
export function passes(row: TruthRow, options: SearchOptions): boolean {
  const sets = options.sets ?? ['listed'];
  const inSet = sets.some((name) =>
    name === 'listed'
      ? row.listed
      : name.startsWith('source:') && row.sources.has(Number(name.slice(7))),
  );
  if (!inSet) return false;
  if (
    row.key < (options.keyMin ?? -Infinity) ||
    row.key > (options.keyMax ?? Infinity)
  ) {
    return false;
  }
  for (const [name, range] of Object.entries(options.filters ?? {})) {
    const value = row[name as 'logP' | 'hba' | 'charge'];
    if (value === null) return false;
    if (value < (range.min ?? -Infinity) || value > (range.max ?? Infinity)) {
      return false;
    }
  }
  return true;
}

/**
 * The ids a substructure search must answer, in order.
 * @param rows - The truth.
 * @param queryIdCode - The query ('' to browse).
 * @param options - The search's options.
 * @returns The ids.
 */
export function substructureTruth(
  rows: TruthRow[],
  queryIdCode: string,
  options: SearchOptions,
): number[] {
  const matched = queryIdCode === '' ? null : matchedRows(rows, queryIdCode);
  const ids: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as TruthRow;
    if ((matched === null || matched.has(i)) && passes(row, options)) {
      ids.push(row.id);
    }
  }
  return ids;
}

const matches = new WeakMap<TruthRow[], Map<string, Set<number>>>();
const fingerprints = new WeakMap<
  TruthRow[],
  Map<SimilarityFingerprint, Int32Array[]>
>();

// The positions of the rows a query matches, by the verifier over every row (memoized per truth).
function matchedRows(rows: TruthRow[], queryIdCode: string): Set<number> {
  let byQuery = matches.get(rows);
  if (byQuery === undefined) matches.set(rows, (byQuery = new Map()));
  let found = byQuery.get(queryIdCode);
  if (found === undefined) {
    const idCodes = rows.map((row) => row.idCode);
    found = new Set(substructureSearch(queryIdCode, idCodes).indexes);
    byQuery.set(queryIdCode, found);
  }
  return found;
}

/**
 * The hits a similarity search must answer: Tanimoto over one fingerprint's words, from the
 * separate wasm calls (FragFp, the screen, or both), score descending then id.
 * @param rows - The truth.
 * @param queryIdCode - The query molecule.
 * @param threshold - The threshold.
 * @param options - The search's options.
 * @param fingerprint - The fingerprint scored.
 * @returns The hits.
 */
export function similarityTruth(
  rows: TruthRow[],
  queryIdCode: string,
  threshold: number,
  options: SearchOptions,
  fingerprint: SimilarityFingerprint = 'fragFp',
): Array<{ id: number; score: number }> {
  const query = fingerprintOf([queryIdCode], fingerprint)[0] as Int32Array;
  let byKind = fingerprints.get(rows);
  if (byKind === undefined) fingerprints.set(rows, (byKind = new Map()));
  let words = byKind.get(fingerprint);
  if (words === undefined) {
    words = fingerprintOf(
      rows.map((row) => row.idCode),
      fingerprint,
    );
    byKind.set(fingerprint, words);
  }
  const out: Array<{ id: number; score: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as TruthRow;
    if (!passes(row, options)) continue;
    const fp = words[i] as Int32Array;
    let shared = 0;
    let either = 0;
    for (let w = 0; w < fp.length; w++) {
      shared += popcount32((fp[w] as number) & (query[w] as number));
      either += popcount32((fp[w] as number) | (query[w] as number));
    }
    const score = shared / either;
    if (score >= threshold) out.push({ id: row.id, score });
  }
  return out.toSorted((a, b) => b.score - a.score || a.id - b.id);
}

/**
 * Each molecule's words in one fingerprint, from the separate wasm calls.
 * @param idCodes - The molecules.
 * @param fingerprint - The fingerprint.
 * @returns 16 words (FragFp or screen) or 32 (both) per molecule.
 */
export function fingerprintOf(
  idCodes: string[],
  fingerprint: SimilarityFingerprint,
): Int32Array[] {
  if (fingerprint === 'fragFp') return getIndexes(idCodes);
  const screens = getScreens(idCodes);
  if (fingerprint === 'screen') return screens;
  return getIndexes(idCodes).map((words, i) => {
    const both = new Int32Array(32);
    both.set(words, 0);
    both.set(screens[i] as Int32Array, 16);
    return both;
  });
}

/**
 * Pages a substructure search or a browse to the end (or `maxPages`); a page that does not move
 * the cursor is retried with twice the budget.
 * @param index - The index.
 * @param queryIdCode - The query, '' to browse.
 * @param options - The search's options.
 * @param maxPages - Pages at most.
 * @returns The hits, the pages read, the partial ones, and whether the answer was exhausted.
 */
export async function readAll(
  index: MoleculeIndex,
  queryIdCode: string,
  options: SearchOptions,
  maxPages = Infinity,
): Promise<{
  ids: number[];
  pages: number;
  partial: number;
  exhausted: boolean;
}> {
  const ids: number[] = [];
  let after: KeyCursor | undefined;
  let pages = 0;
  let partial = 0;
  let budget = options.budgetMs ?? 60_000;
  let stalls = 0;
  for (;;) {
    const page: KeyPage =
      queryIdCode === ''
        ? await index.browse({ ...options, budgetMs: budget, after })
        : await index.substructure(queryIdCode, {
            ...options,
            budgetMs: budget,
            after,
          });
    pages++;
    if (page.partial) partial++;
    for (const hit of page.hits) ids.push(hit.id);
    if (page.next === undefined) {
      return { ids, pages, partial, exhausted: !page.partial };
    }
    if (pages >= maxPages) return { ids, pages, partial, exhausted: false };
    const moved = page.next.key !== after?.key || page.next.id !== after.id;
    stalls = moved ? 0 : stalls + 1;
    if (stalls > 25) throw new Error('the cursor did not move in 25 pages');
    budget = moved
      ? (options.budgetMs ?? 60_000)
      : Math.min(60_000, 2 * budget);
    after = page.next;
  }
}
