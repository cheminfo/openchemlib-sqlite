import { popcount32 } from '../chemistry/bits.ts';

import type { Layout } from './layout.ts';
import type { SearchOptions } from './pages.ts';
import { restrictionWord, setWords } from './pool/setWords.ts';

/** Words of the row space the density of an expression is sampled over. */
const DENSITY_SAMPLES = 2048;

/** The rows a search may answer, as the workers evaluate it word by word. */
export interface SetExpression {
  /** Every alive row. */
  alive: SharedArrayBuffer;
  /** Their union, or null for every alive row. Never empty: an empty union answers nothing. */
  any: SharedArrayBuffer[] | null;
  /** Every one of these. */
  all: SharedArrayBuffer[];
  /** None of these. */
  none: SharedArrayBuffer[];
}

/**
 * The set expression of a search, or null when nothing can answer: `sets` given with no known
 * name (or `[]`), or an unknown name in `allSets`. Unknown names in `noneSets` remove nothing.
 * No bitmap is built: the expression names the version's own bitmaps, which the workers combine
 * word by word.
 * @param layout - The version searched.
 * @param options - The search's sets.
 * @param defaultSets - The index's default sets, null when it has none.
 * @returns The expression, or null.
 */
export function setExpression(
  layout: Layout,
  options: Pick<SearchOptions, 'sets' | 'allSets' | 'noneSets'>,
  defaultSets: readonly string[] | null,
): SetExpression | null {
  const names = options.sets ?? defaultSets;
  let any: SharedArrayBuffer[] | null = null;
  if (names !== null) {
    any = known(layout, names);
    if (any.length === 0) return null;
  }
  const all: SharedArrayBuffer[] = [];
  for (const name of options.allSets ?? []) {
    const map = layout.sets.get(name);
    if (map === undefined) return null;
    // A set the union is made of alone is what the union already keeps.
    if (!all.includes(map) && !(any?.length === 1 && any[0] === map)) {
      all.push(map);
    }
  }
  return {
    alive: layout.alive,
    any,
    all,
    none: known(layout, options.noneSets ?? []),
  };
}

/**
 * The share of alive rows the expression keeps, sampled over 2,048 words (the rank of the
 * restriction among the planes).
 * @param layout - The version searched.
 * @param sets - The expression.
 * @returns The share, from 0 to 1.
 */
export function restrictionDensity(
  layout: Layout,
  sets: SetExpression,
): number {
  const words = Math.floor(layout.rowSpace / 32);
  const x = setWords(sets);
  const alive = x.alive;
  const step = Math.max(1, Math.floor(words / DENSITY_SAMPLES));
  let kept = 0;
  let rows = 0;
  for (let g = 0; g < words; g += step) {
    kept += popcount32(
      x.single === null ? restrictionWord(x, g) : (x.single[g] as number),
    );
    rows += popcount32(alive[g] as number);
  }
  return rows === 0 ? 0 : kept / rows;
}

/**
 * The bitmaps of the known names among some, each once.
 * @param layout - The version searched.
 * @param names - The set names.
 * @returns Their bitmaps.
 */
function known(layout: Layout, names: readonly string[]): SharedArrayBuffer[] {
  const maps: SharedArrayBuffer[] = [];
  for (const name of names) {
    const map = layout.sets.get(name);
    if (map !== undefined && !maps.includes(map)) maps.push(map);
  }
  return maps;
}
