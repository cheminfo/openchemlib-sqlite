import type { StatementSync } from 'node:sqlite';

import { SEQ_SPAN } from '../../chemistry/key.ts';
import { memberParameters } from '../spec.ts';

import type { SetEntry } from './plan.ts';
import type { ReaderContext } from './readerContext.ts';
import { pull } from './readerContext.ts';

/** What the sets phase reads. */
export interface SetsTask {
  /** (set position, segment, first position, end position) per task. */
  tasks: Float64Array;
  sets: SetEntry[];
  /** Per set, its bitmap over the row space. */
  bitmaps: SharedArrayBuffer[];
  indexes: SharedArrayBuffer[];
  seqArrays: SharedArrayBuffer[];
  atomCounts: number[];
  alive: SharedArrayBuffer;
  counter: SharedArrayBuffer;
}

/**
 * The members of each set among a piece of an atom count's seq index: the members SQL over the
 * piece's id range, merged with the index by galloping forward through it. Only alive rows are
 * set: a set never holds a row that cannot be answered.
 * @param context - The reader.
 * @param task - The phase.
 * @returns Members read, members the image lacks, and members set per set.
 */
export function runSets(
  context: ReaderContext,
  task: SetsTask,
): { rows: number; orphans: number; members: number[] } {
  const statements = new Map<string, StatementSync>();
  const statementOf = (family: string): StatementSync => {
    let statement = statements.get(family);
    if (statement === undefined) {
      const spec = context.data.spec.families.find(
        (entry) => entry.family === family,
      );
      if (spec === undefined) throw new Error(`no set family ${family}`);
      statement = context.db.prepare(spec.members);
      statement.setReturnArrays(true);
      statements.set(family, statement);
    }
    return statement;
  };
  const maps = task.bitmaps.map((buffer) => new Int32Array(buffer));
  const alive = new Int32Array(task.alive);
  const members = new Array<number>(task.sets.length).fill(0);
  let rows = 0;
  let orphans = 0;
  for (const t of pull(task.counter, task.tasks.length / 4)) {
    const position = task.tasks[4 * t] as number;
    const s = task.tasks[4 * t + 1] as number;
    const i0 = task.tasks[4 * t + 2] as number;
    const i1 = task.tasks[4 * t + 3] as number;
    const set = task.sets[position] as SetEntry;
    const index = new Int32Array(task.indexes[s] as SharedArrayBuffer);
    const seqs = new Uint32Array(task.seqArrays[s] as SharedArrayBuffer);
    const base = (task.atomCounts[s] as number) * SEQ_SPAN;
    const from = base + (seqs[i0] as number);
    const to = base + (seqs[i1 - 1] as number);
    const parameters = memberParameters(set.value, from, to);
    const map = maps[position] as Int32Array;
    let i = i0;
    for (const row of statementOf(set.family).all(
      parameters,
    ) as unknown as unknown[][]) {
      const seq = Number(row[0]) - base;
      i = gallop(seqs, i, i1, seq);
      rows++;
      if (i === i1 || seqs[i] !== seq) {
        orphans++;
        continue;
      }
      const g = index[i] as number;
      const bit = 1 << (g & 31);
      if (((alive[g >>> 5] as number) & bit) === 0) continue;
      if ((Atomics.or(map, g >>> 5, bit) & bit) === 0) {
        members[position] = (members[position] as number) + 1;
      }
    }
  }
  return { rows, orphans, members };
}

/**
 * The first position in [from, to) whose seq is at least `seq`.
 * @param seqs - Seqs, ascending.
 * @param from - Where to start.
 * @param to - One past the end.
 * @param seq - The seq sought.
 * @returns The position, `to` when none.
 */
export function gallop(
  seqs: Uint32Array,
  from: number,
  to: number,
  seq: number,
): number {
  if (from >= to || (seqs[from] as number) >= seq) return from;
  let lo = from;
  let step = 1;
  let hi = Math.min(to, from + 1);
  while (hi < to && (seqs[hi] as number) < seq) {
    lo = hi;
    step *= 2;
    hi = Math.min(to, lo + step);
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((seqs[mid] as number) < seq) lo = mid;
    else hi = mid;
  }
  return hi;
}
