import { getIndexes, getScreens } from 'openchemlib-search-wasm';

import { popcount32 } from '../chemistry/bits.ts';
import type { MoleculeIndex } from '../search/MoleculeIndex.ts';
import type { SimilarityFingerprint } from '../search/fingerprint.ts';
import type { SearchOptions } from '../search/pages.ts';
import type { SimilarityOptions } from '../search/scorePage.ts';
import type { ScoreCursor } from '../search/walk/similarityPage.ts';

import type { TruthRow } from './truth.ts';
import { passes } from './truth.ts';

const fingerprints = new WeakMap<
  TruthRow[],
  Map<SimilarityFingerprint, Int32Array[]>
>();

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
 * Pages a similarity search to the end, every page complete.
 * @param index - The index.
 * @param idCode - The query molecule.
 * @param options - The search's options.
 * @returns The hits, and the total every page reported.
 */
export async function readAllSimilar(
  index: MoleculeIndex,
  idCode: string,
  options: SimilarityOptions,
): Promise<{ hits: Array<{ id: number; score: number }>; totals: number[] }> {
  const hits: Array<{ id: number; score: number }> = [];
  const totals: number[] = [];
  let after: ScoreCursor | undefined;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- each page continues the previous one
    const page = await index.similarity(idCode, { ...options, after });
    if (page.partial) throw new Error('a similarity page was partial');
    hits.push(...page.hits);
    totals.push(page.total);
    if (page.next === undefined) return { hits, totals };
    after = page.next;
  }
}
