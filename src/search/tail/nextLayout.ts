import { Layout } from '../layout.ts';
import type { Band, Segment } from '../layoutTypes.ts';
import { bandRecord } from '../layoutTypes.ts';

import type { PublishMessage } from './tailState.ts';

/**
 * The version a publish makes from the current one: the new append blocks, new records for the
 * bands it changed (their main runs kept), the segments it added, and the bitmaps it carries.
 * @param previous - The current version.
 * @param message - The publish.
 * @returns The new version.
 */
export function nextLayout(previous: Layout, message: PublishMessage): Layout {
  const blocks = previous.blocks.slice();
  for (const { index, ...block } of message.newBlocks) blocks[index] = block;
  const segments = previous.segments.slice();
  let added = false;
  for (const update of message.segments) {
    let position = segments.findIndex(
      (segment) => segment.atoms === update.atoms,
    );
    if (position < 0) {
      segments.push({
        atoms: update.atoms,
        bands: [],
        index: null,
        indexCount: 0,
        tail: null,
      });
      position = segments.length - 1;
      added = true;
    }
    const old = segments[position] as Segment;
    const bands = old.bands.slice();
    for (const { band, zmin, zmax, rows, ab, aw, an } of update.bands) {
      const at = lowerBand(bands, band);
      if (at < bands.length && (bands[at] as Band).band === band) {
        bands[at] = bandRecord(
          band,
          (bands[at] as Band).runs,
          zmin,
          zmax,
          rows,
          ab,
          aw,
          an,
        );
      } else {
        bands.splice(at, 0, bandRecord(band, [], zmin, zmax, rows, ab, aw, an));
      }
    }
    segments[position] = { ...old, bands, tail: update.tail };
  }
  if (added) segments.sort((a, b) => a.atoms - b.atoms);
  return new Layout(
    {
      version: message.version,
      watermark: message.watermark,
      layout: previous.layout,
      blocks,
      segments,
      rowSpace: message.rowSpace,
      rowSpaceCapacity: message.rowSpaceCapacity,
      histogram: previous.histogram,
      sets: new Map(message.sets),
      alive: message.alive,
      frequencies: previous.frequencies,
    },
    previous.viewCache,
  );
}

function lowerBand(bands: Band[], band: number): number {
  let lo = 0;
  let hi = bands.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((bands[mid] as Band).band < band) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
