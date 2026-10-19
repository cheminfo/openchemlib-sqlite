/* eslint-disable no-await-in-loop -- each page continues the previous one */
import type { DatabaseSync } from 'node:sqlite';

import { substructureSearch } from 'openchemlib-search-wasm';

import type { MoleculeIndex } from '../search/MoleculeIndex.ts';
import type { KeyPage, SearchOptions } from '../search/pages.ts';
import type { KeyCursor } from '../search/walk/walkPage.ts';

import { storedKeys } from './storedKeys.ts';

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
  /**
   * The 48 words of `getMoleculeRecords`: FragFp, the screen, the function keys, as the store keeps
   * them in the molecule's tile slot; empty unless `readTruth` was asked for them.
   */
  keys: Int32Array;
}

/**
 * Every molecule with its application row, from SQL alone, sorted by (key, id).
 * @param db - The test database.
 * @param options - What else to read.
 * @param options.keys - Whether to read each molecule's 48 words, for searches with key bits.
 * @returns The rows.
 */
export function readTruth(
  db: DatabaseSync,
  options: { keys?: boolean } = {},
): TruthRow[] {
  const rows = (
    db
      .prepare(
        'SELECT o.id AS id, o.idCode AS idCode, m.weight AS key, m.logP AS logP, m.hba AS hba, m.charge AS charge, m.listed AS listed FROM ocl_molecule o JOIN molecules m ON m.id = o.id',
      )
      .all() as Array<
      Omit<TruthRow, 'listed' | 'sources' | 'keys'> & { listed: number }
    >
  ).map((row): TruthRow => ({
    ...row,
    listed: row.listed === 1,
    sources: new Set<number>(),
    keys: new Int32Array(0),
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
  if (options.keys === true) {
    const keys = storedKeys(db);
    for (const row of rows) row.keys = keys.get(row.id) as Int32Array;
  }
  return rows.toSorted((a, b) => a.key - b.key || a.id - b.id);
}

/**
 * Whether a row holds a key, as `getMoleculeRecords` numbers its bits.
 * @param row - The row, read with its keys.
 * @param bit - The key bit, 0 to 1535.
 * @returns True when it holds it.
 */
export function holdsKey(row: TruthRow, bit: number): boolean {
  if (row.keys.length === 0) throw new Error('read the truth with its keys');
  return ((row.keys[bit >> 5] as number) & (1 << (31 - (bit & 31)))) !== 0;
}

/**
 * Whether a row belongs to a set of the test specification.
 * @param row - The row.
 * @param name - `listed` or `source:<id>`.
 * @returns True when it belongs to it.
 */
export function inSet(row: TruthRow, name: string): boolean {
  if (name === 'listed') return row.listed;
  return name.startsWith('source:') && row.sources.has(Number(name.slice(7)));
}

/**
 * Whether a row passes a search's sets, key bits, filters and key bounds, on exact values.
 * @param row - The row.
 * @param options - The search's options.
 * @returns True when the index must answer it.
 */
export function passes(row: TruthRow, options: SearchOptions): boolean {
  const sets = options.sets ?? ['listed'];
  if (!sets.some((name) => inSet(row, name))) return false;
  if (!(options.allSets ?? []).every((name) => inSet(row, name))) return false;
  if ((options.noneSets ?? []).some((name) => inSet(row, name))) return false;
  const { all = [], any = [], none = [] } = options.bits ?? {};
  if (!all.every((bit) => holdsKey(row, bit))) return false;
  if (any.length > 0 && !any.some((bit) => holdsKey(row, bit))) return false;
  if (none.some((bit) => holdsKey(row, bit))) return false;
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
