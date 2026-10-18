import type { Block } from '../blocks.ts';

import type {
  PublishMessage,
  PublishedBand,
  TailCheckpoint,
  TailCounters,
  TailSegment,
} from './tailState.ts';
import type { TailStore } from './tailStore.ts';

/**
 * What changed since the last publish, as a publish message, and resets it. The segments touched
 * carry their touched bands' numbers and their tail index; the bitmaps are always sent (a set
 * added or grown is a new buffer).
 * @param store - The tail store.
 * @param version - The version this publish makes.
 * @param watermark - Every seq up to it is in the image.
 * @param counters - What the tail took in so far.
 * @returns The message.
 */
export function takeChanges(
  store: TailStore,
  version: number,
  watermark: number,
  counters: TailCounters,
): PublishMessage {
  const touched = new Map<number, PublishedBand[]>();
  for (const { atoms, band } of store.pending.touched.values()) {
    const segment = store.segments.get(atoms) as TailSegment;
    const record = segment.bands.get(band);
    if (record === undefined) continue;
    let list = touched.get(atoms);
    if (list === undefined) touched.set(atoms, (list = []));
    list.push({
      band,
      zmin: record.zmin,
      zmax: record.zmax,
      rows: record.rows,
      ab: record.ab,
      aw: record.aw,
      an: record.an,
    });
  }
  const message: PublishMessage = {
    type: 'publish',
    version,
    watermark,
    rowSpace: store.rowSpace,
    rowSpaceCapacity: store.bitmaps.capacity,
    newBlocks: store.pending.newBlocks.map((index) => ({
      ...(store.blocks[index] as Block),
      index,
    })),
    segments: [...touched].map(([atoms, bands]) => {
      const { tail } = store.segments.get(atoms) as TailSegment;
      return {
        atoms,
        bands,
        tail: tail === null ? null : { buffer: tail.buffer, count: tail.count },
      };
    }),
    sets: [...store.bitmaps.sets.values()].map((set) => [set.name, set.buffer]),
    alive: store.bitmaps.alive.buffer,
    counters,
  };
  for (const segment of store.segments.values()) segment.tailOwned = false;
  store.pending.newBlocks = [];
  store.pending.touched = new Map();
  store.pending.any = false;
  store.bitmaps.changed = false;
  return message;
}

/**
 * Where the tail stands: its position in the file, and per band the tile it reads next.
 * @param store - The tail store.
 * @param position - Its version, watermark, change id, counters, and why it stopped.
 * @returns The checkpoint.
 */
export function takeCheckpoint(
  store: TailStore,
  position: Omit<TailCheckpoint, 'tailFrom' | 'sets'>,
): TailCheckpoint {
  return {
    ...position,
    tailFrom: [...store.segments.values()].map((segment) => [
      segment.atoms,
      [...segment.bands.values()].map((band) => [band.band, band.tailFrom]),
    ]),
    sets: [...store.bitmaps.sets.values()].map(({ name, family, value }) => ({
      name,
      family,
      value,
    })),
  };
}
