/* eslint-disable no-await-in-loop -- the file is read in order, one chunk at a time */
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';

import type { Block } from '../blocks.ts';
import { Layout } from '../layout.ts';
import type { Segment } from '../layoutTypes.ts';
import { bandRecord } from '../layoutTypes.ts';
import type { LoadedImage } from '../load/loadImage.ts';
import type { LoadProgressListener } from '../load/loadProgress.ts';
import type { NormalizedSpec } from '../spec.ts';

import { readFully, readHeader } from './readHeader.ts';
import { refusalOf } from './snapshotChecks.ts';
import type { SnapshotHeader } from './snapshotFile.ts';
import { dataStart, padded } from './snapshotFile.ts';

const MIB = 1024 * 1024;

/** Where a snapshot is, and what it is checked against. */
export interface RestoreOptions {
  /** The snapshot. */
  path: string;
  /** The database the index is opened on. */
  file: string;
  spec: NormalizedSpec;
  /** The share of its rows the store may have moved past it. */
  staleShare: number;
  /** Hears the step, `snapshot`, in MiB read. */
  listener: LoadProgressListener;
}

/**
 * Reads back the image a snapshot holds, its sections streamed in order into new shared buffers.
 * The tail then catches up from the snapshot's watermark and change id, as it would from a load.
 * @param options - The snapshot, the database and the specification.
 * @returns The image, or null when there is no snapshot or it cannot be used (the step's note
 * says why).
 */
export async function restoreSnapshot(
  options: RestoreOptions,
): Promise<LoadedImage | null> {
  const { path, file, spec, staleShare, listener } = options;
  const started = performance.now();
  const refuse = (note: string): null => {
    listener({ step: 'snapshot', done: 0, total: 0, finished: true, note });
    return null;
  };
  listener({ step: 'snapshot', done: 0, total: 0, finished: false });
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return refuse(code === 'ENOENT' ? 'none saved yet' : String(error));
  }
  try {
    const { size } = await handle.stat();
    const read = await readHeader(handle);
    if (read === null) return refuse('not a snapshot');
    const { header, length } = read;
    const refusal = await refusalOf(header, {
      file,
      spec,
      staleShare,
      fileBytes: size,
      headerBytes: length,
    });
    if (refusal !== null) return refuse(refusal);
    let bytes = 0;
    for (const section of header.sections) bytes += section;
    const total = Math.ceil(bytes / MIB);
    const image = await readImage(handle, header, dataStart(length), (done) =>
      listener({
        step: 'snapshot',
        done: Math.floor(done / MIB),
        total,
        finished: false,
      }),
    );
    image.stats.ms = performance.now() - started;
    listener({ step: 'snapshot', done: total, total, finished: true });
    return image;
  } catch (error) {
    return refuse(
      `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle.close();
  }
}

/**
 * The image, from the sections in the order `saveSnapshot` writes them.
 * @param handle - The snapshot.
 * @param header - Its header.
 * @param start - Where its sections start.
 * @param onRead - Hears the bytes read so far.
 * @returns The image.
 */
async function readImage(
  handle: FileHandle,
  header: SnapshotHeader,
  start: number,
  onRead: (bytes: number) => void,
): Promise<LoadedImage> {
  let position = start;
  let read = 0;
  let next = 0;
  const into = async (target: Uint8Array) => {
    await readFully(handle, target, position, (done) => onRead(read + done));
    read += target.length;
    position += padded(target.length);
    next++;
  };
  const shared = async (): Promise<SharedArrayBuffer> => {
    const buffer = new SharedArrayBuffer(header.sections[next]);
    await into(new Uint8Array(buffer));
    return buffer;
  };
  const blocks: Block[] = [];
  for (const { capacity, start: first, atoms, append } of header.blocks) {
    const planes = await shared();
    const columns = await shared();
    blocks.push({ planes, columns, capacity, start: first, atoms, append });
  }
  const segments: Segment[] = [];
  for (const { atoms, bands, indexCount, indexed } of header.segments) {
    const index = indexed ? await shared() : null;
    segments.push({
      atoms,
      bands: bands.map((band) =>
        bandRecord(
          band.band,
          band.runs,
          band.zmin,
          band.zmax,
          band.rows,
          band.ab,
          band.aw,
          band.an,
        ),
      ),
      index,
      indexCount,
      tail: null,
    });
  }
  const counts = await shared();
  const alive = await shared();
  const sets = new Map<string, SharedArrayBuffer>();
  for (const name of header.sets) sets.set(name, await shared());
  const frequencies = new Float64Array((header.sections[next] as number) / 8);
  await into(new Uint8Array(frequencies.buffer));
  const layout = new Layout({
    version: 0,
    watermark: header.watermark,
    layout: header.layout,
    blocks,
    segments,
    rowSpace: header.rowSpace,
    rowSpaceCapacity: header.rowSpaceCapacity,
    histogram: {
      counts,
      lo: header.histogram.lo,
      scale: header.histogram.scale,
    },
    sets,
    alive,
    frequencies,
  });
  return {
    layout,
    plan: header.plan,
    tailFrom: header.tailFrom.map((starts) => Int32Array.from(starts)),
    stats: { ...header.stats, ms: 0 },
  };
}
