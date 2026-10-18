import {
  getIndex,
  getMoleculeSizes,
  getQueryAtomFloor,
  getQueryIndex,
  getQueryScreen,
  getScreen,
} from 'openchemlib-search-wasm';

import { countBits, popcount32 } from '../chemistry/bits.ts';
import { clampAtoms } from '../chemistry/key.ts';

import type { ColumnLayout } from './blocks.ts';
import type { SimilarityFingerprint } from './fingerprint.ts';
import { fingerprintWords } from './fingerprint.ts';
import type { Layout } from './layout.ts';
import type { ColumnBound } from './pool/rowFilter.ts';
import type { SimilarityPlan } from './walk/similarityPage.ts';
import type { SubstructurePlan } from './walk/walkPage.ts';

/** Inclusive bounds on one filter column. */
export interface FilterRange {
  /** The least value kept. */
  min?: number;
  /** The largest value kept. */
  max?: number;
}

/**
 * Plans a substructure query: its FragFp and screen bits (built on the fragment the verifier
 * matches) as planes rarest first, and its atom floor. An empty query is a browse.
 * @param queryIdCode - The query, read as a fragment whatever its own flag; '' to browse.
 * @param frequencies - How often each plane's bit is set.
 * @returns The plan.
 */
export function substructurePlan(
  queryIdCode: string,
  frequencies: Float64Array,
): SubstructurePlan {
  if (queryIdCode === '') {
    return {
      browse: true,
      queryIdCode: '',
      planes: new Int32Array(0),
      floor: 0,
    };
  }
  const words = new Int32Array(32);
  words.set(getQueryIndex(queryIdCode), 0);
  words.set(getQueryScreen(queryIdCode), 16);
  return {
    browse: false,
    queryIdCode,
    planes: rarestPlanes(words, 0, 32, frequencies),
    floor: clampAtoms(getQueryAtomFloor(queryIdCode)),
  };
}

/**
 * Plans a similarity query on one fingerprint: the query's bits there, the window
 * [⌈t·|q|⌉, ⌊|q|/t⌋] of bit counts a row must lie in, and the least shared count a row of the
 * window passes with. A query with no bit in the fingerprint has `qBits` 0: nothing can be scored.
 * @param idCode - The query molecule.
 * @param threshold - The Tanimoto coefficient a hit reaches, in (0, 1].
 * @param fingerprint - The fingerprint scored.
 * @param frequencies - How often each plane's bit is set.
 * @returns The plan.
 */
export function similarityPlan(
  idCode: string,
  threshold: number,
  fingerprint: SimilarityFingerprint,
  frequencies: Float64Array,
): SimilarityPlan {
  if (!(threshold > 0 && threshold <= 1)) {
    throw new RangeError(
      `the similarity threshold is in (0, 1], not ${threshold}`,
    );
  }
  const [from, to] = fingerprintWords(fingerprint);
  const words = new Int32Array(32);
  if (from === 0) words.set(getIndex(idCode), 0);
  if (to === 32) words.set(getScreen(idCode), 16);
  const qBits = countBits(words, from, to);
  const low = Math.max(0, Math.ceil(threshold * qBits - 1e-9));
  const high = Math.floor(qBits / threshold + 1e-9);
  let mMin = qBits + 1;
  for (let shared = 1; shared <= qBits; shared++) {
    const bits = Math.max(low, shared);
    if (bits > high) break;
    if (shared / (qBits + bits - shared) >= threshold) {
      mMin = shared;
      break;
    }
  }
  const atoms = getMoleculeSizes([idCode]).atomCounts[0] as number;
  return {
    fingerprint,
    planes: rarestPlanes(words, from, to, frequencies),
    qBits,
    low,
    high,
    threshold,
    mMin,
    D: qBits - mMin,
    atoms: clampAtoms(atoms),
  };
}

/**
 * A search's filters as bounds on the layout's columns.
 * @param layout - The column layout.
 * @param filters - The filters, by column name.
 * @returns The bounds.
 */
export function readFilters(
  layout: ColumnLayout,
  filters: Record<string, FilterRange> = {},
): ColumnBound[] {
  const bounds: ColumnBound[] = [];
  for (const [name, range] of Object.entries(filters)) {
    const column = layout.filters.findIndex((filter) => filter.name === name);
    if (column === -1) throw new Error(`no filter column named "${name}"`);
    const min = range.min ?? -Infinity;
    const max = range.max ?? Infinity;
    if (min === -Infinity && max === Infinity) continue;
    bounds.push({ column, min, max });
  }
  return bounds;
}

/**
 * The rows a search may answer: the union of the named sets, or every alive row without any.
 * @param layout - The version searched.
 * @param sets - The set names; unknown names add nothing.
 * @returns The bitmap over the row space.
 */
export function restrictionOf(
  layout: Layout,
  sets: readonly string[] | null,
): SharedArrayBuffer {
  if (sets === null) return layout.alive;
  const maps = sets.flatMap((name) => {
    const map = layout.sets.get(name);
    return map === undefined ? [] : [map];
  });
  if (maps.length === 1) return maps[0] as SharedArrayBuffer;
  const buffer = new SharedArrayBuffer(layout.rowSpaceCapacity / 8);
  const out = new Int32Array(buffer);
  for (const map of maps) {
    const words = new Int32Array(map, 0, out.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = (out[i] as number) | (words[i] as number);
    }
  }
  return buffer;
}

/**
 * Where the restriction word goes among the query planes: its density, sampled over the row space
 * against the alive rows, ranks it with the planes' frequencies.
 * @param layout - The version searched.
 * @param restriction - The restriction bitmap.
 * @param plan - The query.
 * @returns How many query planes are tested before it.
 */
export function restrictionRank(
  layout: Layout,
  restriction: SharedArrayBuffer,
  plan: SubstructurePlan,
): number {
  const words = Math.floor(layout.rowSpace / 32);
  const restr = new Int32Array(restriction);
  const alive = new Int32Array(layout.alive);
  const step = Math.max(1, Math.floor(words / 2048));
  let kept = 0;
  let rows = 0;
  for (let w = 0; w < words; w += step) {
    kept += popcount32(restr[w] as number);
    rows += popcount32(alive[w] as number);
  }
  const density = rows === 0 ? 0 : kept / rows;
  let at = 0;
  while (
    at < plan.planes.length &&
    (layout.frequencies[plan.planes[at] as number] as number) < density
  ) {
    at++;
  }
  return at;
}

function rarestPlanes(
  words: Int32Array,
  from: number,
  to: number,
  frequencies: Float64Array,
): Int32Array {
  const planes: number[] = [];
  for (let w = from; w < to; w++) {
    const value = words[w] as number;
    for (let bit = 0; bit < 32; bit++) {
      if ((value & (1 << bit)) !== 0) planes.push(w * 32 + bit);
    }
  }
  planes.sort(
    (a, b) => (frequencies[a] as number) - (frequencies[b] as number) || a - b,
  );
  return Int32Array.from(planes);
}
