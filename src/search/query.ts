import {
  getIndex,
  getMoleculeSizes,
  getQueryAtomFloor,
  getQueryIndex,
  getQueryScreen,
  getScreen,
} from 'openchemlib-search-wasm';

import { countBits } from '../chemistry/bits.ts';
import { clampAtoms } from '../chemistry/key.ts';

import type { ColumnLayout } from './blocks.ts';
import type { SimilarityFingerprint } from './fingerprint.ts';
import { fingerprintWords } from './fingerprint.ts';
import type { KeyPlanes } from './keyBits.ts';
import type { Layout } from './layout.ts';
import type { ColumnBound } from './pool/rowFilter.ts';
import type { SetExpression } from './setExpression.ts';
import { restrictionDensity } from './setExpression.ts';
import type { SimilarityPlan } from './walk/similarityPage.ts';
import type { SubstructurePlan } from './walk/walkPage.ts';

/** Inclusive bounds on one filter column. */
export interface FilterRange {
  /**
   * The least value kept.
   * @default no lower bound
   */
  min?: number;
  /**
   * The largest value kept.
   * @default no upper bound
   */
  max?: number;
}

/**
 * Plans a substructure query: its FragFp and screen bits (built on the fragment the verifier
 * matches) and the key planes a row must hold, flip 0, or lack, flip -1, merged and ordered by
 * survival, rarest first; the OR group of keys apart; and its atom floor. An empty query is a
 * browse, keys or not: it is never verified.
 * @param queryIdCode - The query, read as a fragment whatever its own flag; '' to browse.
 * @param frequencies - How often each plane's bit is set.
 * @param keys - The key planes of the search.
 * @returns The plan.
 */
export function substructurePlan(
  queryIdCode: string,
  frequencies: Float64Array,
  keys: KeyPlanes,
): SubstructurePlan {
  const browse = queryIdCode === '';
  const held = new Set<number>(keys.all);
  if (!browse) {
    const words = new Int32Array(32);
    words.set(getQueryIndex(queryIdCode), 0);
    words.set(getQueryScreen(queryIdCode), 16);
    for (const plane of setPlanes(words, 0, 32)) held.add(plane);
  }
  const { planes, flips } = orderPlanes(held, keys.none, frequencies);
  return {
    browse,
    queryIdCode,
    planes,
    flips,
    anyPlanes: keys.any,
    floor: browse ? 0 : clampAtoms(getQueryAtomFloor(queryIdCode)),
  };
}

/**
 * Planes a row must hold (flip 0) and planes it must lack (flip -1), ordered by survival
 * ascending: the plane's frequency for flip 0, one minus it for flip -1, ties by plane.
 * @param held - The planes a row must hold.
 * @param lacked - The planes it must lack.
 * @param frequencies - How often each plane's bit is set.
 * @returns The planes and their flips, in that order.
 */
export function orderPlanes(
  held: Iterable<number>,
  lacked: Int32Array,
  frequencies: Float64Array,
): { planes: Int32Array; flips: Int32Array } {
  const list: Array<{ plane: number; flip: number; survival: number }> = [];
  for (const plane of held) {
    list.push({ plane, flip: 0, survival: frequencies[plane] as number });
  }
  for (const plane of lacked) {
    list.push({
      plane,
      flip: -1,
      survival: 1 - (frequencies[plane] as number),
    });
  }
  list.sort((a, b) => a.survival - b.survival || a.plane - b.plane);
  const planes = new Int32Array(list.length);
  const flips = new Int32Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as { plane: number; flip: number };
    planes[i] = entry.plane;
    flips[i] = entry.flip;
  }
  return { planes, flips };
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
    planes: orderPlanes(
      setPlanes(words, from, to),
      new Int32Array(0),
      frequencies,
    ).planes,
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
 * Where the restriction word goes among the planes of a walk: its density, sampled over the row
 * space against the alive rows, ranks it with the planes' survival (a plane's frequency, or one
 * minus it for a plane the row must lack).
 * @param layout - The version searched.
 * @param sets - The set expression.
 * @param plan - The planes and their flips.
 * @param plan.planes - The planes, by survival ascending.
 * @param plan.flips - 0 for a plane a row must hold, -1 for one it must lack.
 * @returns How many planes are tested before it.
 */
export function restrictionRank(
  layout: Layout,
  sets: SetExpression,
  plan: { planes: Int32Array; flips: Int32Array },
): number {
  const density = restrictionDensity(layout, sets);
  const { planes, flips } = plan;
  let at = 0;
  for (; at < planes.length; at++) {
    const frequency = layout.frequencies[planes[at] as number] as number;
    const survival = flips[at] === 0 ? frequency : 1 - frequency;
    if (!(survival < density)) break;
  }
  return at;
}

function setPlanes(words: Int32Array, from: number, to: number): number[] {
  const planes: number[] = [];
  for (let w = from; w < to; w++) {
    const value = words[w] as number;
    for (let bit = 0; bit < 32; bit++) {
      if ((value & (1 << bit)) !== 0) planes.push(w * 32 + bit);
    }
  }
  return planes;
}
