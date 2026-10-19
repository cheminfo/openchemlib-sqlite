import type { CountRequest } from './countOptions.ts';
import type { CountOptions } from './countPage.ts';
import type { Layout } from './layout.ts';
import type { Band } from './layoutTypes.ts';
import type { SearchPool } from './pool/SearchPool.ts';
import type { CountedReply } from './pool/messages.ts';
import type { ColumnBound } from './pool/rowFilter.ts';
import { orderPlanes, restrictionRank } from './query.ts';
import { setExpression } from './setExpression.ts';
import type { SliceWork, WorkUnits } from './units.ts';
import { sliceWork } from './units.ts';

/** What the index hands a count. */
export interface CountContext {
  pool: SearchPool;
  /** The version searched now: each range counts the one current when it starts. */
  current: () => Layout;
  defaultSets: string[] | null;
  budgetMs: number;
  /** The rows of one range, about. */
  chunkRows: number;
}

/** A count under way: what it tallies and where it is. */
export interface CountChunk {
  request: CountRequest;
  options: CountOptions;
  bounds: ColumnBound[];
  /** The start of the next range. */
  lo: number;
  /** The count's inclusive end. */
  end: number;
  /** A performance.now() time. */
  deadline: number;
  /** The tallies summed so far. */
  tallies: Float64Array;
}

/** The work of one range, and whether each unit's rows all have a key inside it. */
export interface CountWork extends WorkUnits {
  whole: Uint8Array;
}

/**
 * Counts one range of keys, [lo, hi) or [lo, end] for the last one, in the version current now:
 * one phase over the bands whose zones meet it, a band whose zone lies inside the range reading no
 * key. The workers' tallies are added to the count's.
 * @param context - The index's state.
 * @param chunk - The count under way.
 * @returns The start of the next range, null after the last one, undefined when the deadline or
 * the signal ended the phase first.
 */
export async function countChunk(
  context: CountContext,
  chunk: CountChunk,
): Promise<number | null | undefined> {
  const layout = context.current();
  const { request, options, bounds, lo, end, deadline, tallies } = chunk;
  const { end: hi } = layout.sliceEnd(lo, context.chunkRows);
  const last = hi > end || hi === Infinity;
  const next = last ? null : hi;
  const top = last ? Infinity : hi;
  const sets = setExpression(layout, options, context.defaultSets);
  if (sets === null) return next;
  const work = countWork(layout, lo, top, end);
  const nUnits = work.units.length / 2;
  if (nUnits === 0) return next;
  const { keys, bySets, byKeys, membershipOf, histogram } = request;
  const plan = orderPlanes(keys.all, keys.none, layout.frequencies);
  let done = 0;
  const phase = await context.pool.phase(
    {
      type: 'count',
      entries: work.entries,
      units: work.units,
      whole: work.whole,
      counter: new SharedArrayBuffer(4),
      planes: plan.planes,
      flips: plan.flips,
      anyPlanes: keys.any,
      sets,
      restrictionAt: restrictionRank(layout, sets, plan),
      lo,
      hi: top,
      end,
      bounds,
      bySets: setsOf(layout, bySets),
      byKeys,
      membership: setsOf(layout, membershipOf),
      histogram,
      tallies: tallies.length,
    },
    {
      deadline,
      signal: options.signal,
      onMessage: (reply) => {
        const counted = reply as CountedReply;
        const part = counted.tallies;
        for (let i = 0; i < part.length; i++) {
          tallies[i] = (tallies[i] as number) + (part[i] as number);
        }
        done += counted.units;
        return done === nUnits;
      },
    },
  );
  return phase.reason === 'done' ? next : undefined;
}

/**
 * The work of one range: the units of the bands whose zone lies inside it, whose rows need no key
 * read, then those of the bands it only meets.
 * @param layout - The version counted.
 * @param lo - The range's start.
 * @param hi - Its exclusive end, Infinity for the last range.
 * @param end - The count's inclusive end.
 * @returns The work.
 */
export function countWork(
  layout: Layout,
  lo: number,
  hi: number,
  end: number,
): CountWork {
  const inside = (band: Band) =>
    band.zmin >= lo && band.zmax < hi && band.zmax <= end;
  const whole = sliceWork(layout.segments, 0, lo, hi, end, inside);
  const rest = sliceWork(
    layout.segments,
    0,
    lo,
    hi,
    end,
    (band) => !inside(band),
  );
  return joinWork(whole, rest);
}

function joinWork(whole: SliceWork, rest: SliceWork): CountWork {
  const entries = new Float64Array(
    new SharedArrayBuffer(
      8 * Math.max(1, whole.entries.length + rest.entries.length),
    ),
    0,
    whole.entries.length + rest.entries.length,
  );
  entries.set(whole.entries);
  entries.set(rest.entries, whole.entries.length);
  const nWhole = whole.units.length;
  const units = new Int32Array(
    new SharedArrayBuffer(4 * Math.max(1, nWhole + rest.units.length)),
    0,
    nWhole + rest.units.length,
  );
  units.set(whole.units);
  const offset = whole.entries.length / 4;
  for (let i = 0; i < rest.units.length; i++) {
    units[nWhole + i] = (rest.units[i] as number) + offset;
  }
  const flags = new Uint8Array(units.length / 2);
  flags.fill(1, 0, nWhole / 2);
  return { entries, units, whole: flags };
}

function setsOf(
  layout: Layout,
  names: readonly string[],
): Array<SharedArrayBuffer | null> {
  const maps = new Array<SharedArrayBuffer | null>(names.length);
  for (let i = 0; i < names.length; i++) {
    maps[i] = layout.sets.get(names[i] as string) ?? null;
  }
  return maps;
}
