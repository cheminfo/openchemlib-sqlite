import type { BlockViews, ColumnLayout } from '../blocks.ts';
import { INT16_LIMIT, INT16_NULL, INT32_LIMIT, INT32_NULL } from '../blocks.ts';

/** One filter of a search, on one column: inclusive bounds on the exact value. */
export interface ColumnBound {
  /** The filter column's position in the layout. */
  column: number;
  /** Inclusive bounds, -Infinity and Infinity when absent. */
  min: number;
  max: number;
}

/** Reads a row's exact values: the columns SQL row of one id, or undefined when it has none. */
export type ExactRow = (id: number) => readonly unknown[] | undefined;

/**
 * The filter test of a block's rows, or null without filters. A value held exactly decides alone;
 * a float32 equal to a rounded bound, or a saturated int, is decided on its exact value, read
 * with the columns SQL (rare rows).
 * @param views - The block's views.
 * @param layout - The column layout.
 * @param bounds - The search's filters.
 * @param exact - Reads a row's exact values.
 * @returns The test of a row (row in the block, id), or null.
 */
export function rowFilter(
  views: BlockViews,
  layout: ColumnLayout,
  bounds: readonly ColumnBound[],
  exact: ExactRow,
): ((row: number, id: number) => boolean) | null {
  if (bounds.length === 0) return null;
  const n = bounds.length;
  const columns = bounds.map(
    (bound) => views.filters[bound.column] as BlockViews['filters'][number],
  );
  const kinds = Int8Array.from(bounds, (bound) => {
    const type = (
      layout.filters[bound.column] as ColumnLayout['filters'][number]
    ).type;
    return type === 'float64'
      ? 0
      : type === 'float32'
        ? 1
        : type === 'int32'
          ? 2
          : 3;
  });
  const min = Float64Array.from(bounds, (bound) => bound.min);
  const max = Float64Array.from(bounds, (bound) => bound.max);
  const roundedMin = Float64Array.from(bounds, (bound) =>
    Math.fround(bound.min),
  );
  const roundedMax = Float64Array.from(bounds, (bound) =>
    Math.fround(bound.max),
  );
  return (row, id) => {
    let unsure = false;
    for (let j = 0; j < n; j++) {
      const x = (columns[j] as BlockViews['filters'][number])[row] as number;
      const kind = kinds[j] as number;
      if (kind === 0) {
        if (!(x >= (min[j] as number) && x <= (max[j] as number))) return false;
      } else if (kind === 1) {
        const lo = roundedMin[j] as number;
        const hi = roundedMax[j] as number;
        if (!(x >= lo && x <= hi)) return false;
        if (x === lo || x === hi) unsure = true;
      } else {
        const empty = kind === 2 ? INT32_NULL : INT16_NULL;
        const limit = kind === 2 ? INT32_LIMIT : INT16_LIMIT;
        if (x === empty) return false;
        if (x === limit || x === -limit) unsure = true;
        else if (x < (min[j] as number) || x > (max[j] as number)) return false;
      }
    }
    return !unsure || exactPass(exact(id), bounds);
  };
}

function exactPass(
  values: readonly unknown[] | undefined,
  bounds: readonly ColumnBound[],
): boolean {
  if (values === undefined) return false;
  for (const bound of bounds) {
    const value = values[2 + bound.column];
    if (value === null || value === undefined) return false;
    const x = Number(value);
    if (!(x >= bound.min && x <= bound.max)) return false;
  }
  return true;
}
