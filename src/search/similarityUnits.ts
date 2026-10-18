import { SLOTS } from '../chemistry/tile.ts';

import type { Band, Segment } from './layoutTypes.ts';
import type { WorkUnits } from './units.ts';
import { byBlock } from './units.ts';

/**
 * Every row as similarity reads it: each atom count's part (its main words and append areas in
 * units of at most `unitWords` words), nearest atom count first, then by atom count. A part is
 * built once per band list, so a version shares the parts of the atom counts the tail left alone.
 * @param segments - The version's segments.
 * @param unitWords - Words per unit.
 * @param atoms - The query's atom count.
 * @returns The work.
 */
export function similarityWork(
  segments: readonly Segment[],
  unitWords: number,
  atoms: number,
): WorkUnits {
  const parts: Array<{ atoms: number; part: WorkUnits }> = [];
  let entryCount = 0;
  let unitCount = 0;
  for (const segment of segments) {
    const part = similarityPart(segment.bands, unitWords);
    if (part.units.length === 0) continue;
    parts.push({ atoms: segment.atoms, part });
    entryCount += part.entries.length;
    unitCount += part.units.length;
  }
  parts.sort(
    (a, b) =>
      Math.abs(a.atoms - atoms) - Math.abs(b.atoms - atoms) ||
      a.atoms - b.atoms,
  );
  const entries = new Float64Array(
    new SharedArrayBuffer(Math.max(1, entryCount) * 8),
    0,
    entryCount,
  );
  const units = new Int32Array(
    new SharedArrayBuffer(Math.max(1, unitCount) * 4),
    0,
    unitCount,
  );
  let e = 0;
  let u = 0;
  for (const { part } of parts) {
    entries.set(part.entries, e);
    const offset = e / 4;
    for (let i = 0; i < part.units.length; i++) {
      units[u + i] = (part.units[i] as number) + offset;
    }
    e += part.entries.length;
    u += part.units.length;
  }
  return { entries, units };
}

const parts = new WeakMap<Band[], WorkUnits & { unitWords: number }>();

function similarityPart(bands: Band[], unitWords: number): WorkUnits {
  const cached = parts.get(bands);
  if (cached?.unitWords === unitWords) return cached;
  const list: number[] = [];
  const areas: number[] = [];
  let b0 = -1;
  let w0 = 0;
  let w1 = 0;
  const flush = () => {
    for (let w = w0; w < w1; w += unitWords) {
      list.push(b0, w, Math.min(w + unitWords, w1), -1);
    }
  };
  for (const band of bands) {
    for (const run of band.runs) {
      if (b0 === run[0] && w1 === run[1]) {
        w1 = run[2];
      } else {
        if (b0 >= 0) flush();
        [b0, w0, w1] = run;
      }
    }
    if (band.ab >= 0 && band.an > 0) areas.push(band.ab, band.aw, band.an);
  }
  if (b0 >= 0) flush();
  const grouped = byBlock(areas);
  for (let i = 0; i < grouped.length; i += 3) {
    const n = grouped[i + 2] as number;
    const rest = n % SLOTS;
    const aw = grouped[i + 1] as number;
    list.push(
      grouped[i] as number,
      aw,
      aw + Math.ceil(n / SLOTS),
      rest === 0 ? -1 : (1 << rest) - 1,
    );
  }
  const units: number[] = [];
  let firstEntry = 0;
  let words = 0;
  for (let i = 0; i < list.length; i += 4) {
    const span = (list[i + 2] as number) - (list[i + 1] as number);
    if (words > 0 && words + span > unitWords) {
      units.push(firstEntry, i / 4);
      firstEntry = i / 4;
      words = 0;
    }
    words += span;
  }
  if (words > 0) units.push(firstEntry, list.length / 4);
  const part = {
    unitWords,
    entries: Float64Array.from(list),
    units: Int32Array.from(units),
  };
  parts.set(bands, part);
  return part;
}
