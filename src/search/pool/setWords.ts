import type { SetExpression } from '../setExpression.ts';

/** A set expression as a worker reads it. */
export interface SetWords {
  alive: Int32Array;
  any: Int32Array[] | null;
  all: Int32Array[];
  none: Int32Array[];
  /** The one bitmap the expression is when it is a single set or alive alone, read directly; else null. */
  single: Int32Array | null;
}

/**
 * Int32 views of an expression. A bitmap posted to a worker arrives as a new SharedArrayBuffer
 * with each message, so the views are made once per phase, never cached across phases.
 * @param expression - The expression.
 * @returns Its views.
 */
export function setWords(expression: SetExpression): SetWords {
  const alive = new Int32Array(expression.alive);
  const any = expression.any === null ? null : views(expression.any);
  const all = views(expression.all);
  const none = views(expression.none);
  return { alive, any, all, none, single: singleOf(alive, any, all, none) };
}

/**
 * One word of the rows a search may answer: the union of `any` (alive when null), AND every
 * `all`, AND NOT every `none`. Sets hold alive rows only, so the word does too.
 * @param x - The expression.
 * @param g - The word, in the row space.
 * @returns The rows, one bit each.
 */
export function restrictionWord(x: SetWords, g: number): number {
  const { alive, any, all, none } = x;
  let word = 0;
  if (any === null) {
    word = alive[g] as number;
  } else {
    for (const map of any) word |= map[g] as number;
  }
  for (let i = 0; i < all.length && word !== 0; i++) {
    word &= (all[i] as Int32Array)[g] as number;
  }
  for (let i = 0; i < none.length && word !== 0; i++) {
    word &= ~((none[i] as Int32Array)[g] as number);
  }
  return word;
}

function views(buffers: readonly SharedArrayBuffer[]): Int32Array[] {
  const out = new Array<Int32Array>(buffers.length);
  for (let i = 0; i < buffers.length; i++) {
    out[i] = new Int32Array(buffers[i] as SharedArrayBuffer);
  }
  return out;
}

/**
 * The one bitmap an expression is, when it is one: sets hold alive rows only, so a set ANDed with
 * every alive row is the set.
 * @param alive - The alive rows.
 * @param any - The union's sets, null for every alive row.
 * @param all - The sets a row belongs to, every one.
 * @param none - The sets it belongs to none of.
 * @returns The bitmap, or null when the expression combines several.
 */
function singleOf(
  alive: Int32Array,
  any: Int32Array[] | null,
  all: Int32Array[],
  none: Int32Array[],
): Int32Array | null {
  if (none.length > 0) return null;
  if (any === null) {
    if (all.length === 0) return alive;
    return all.length === 1 ? (all[0] as Int32Array) : null;
  }
  return any.length === 1 && all.length === 0 ? (any[0] as Int32Array) : null;
}
