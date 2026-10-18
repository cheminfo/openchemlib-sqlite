/* eslint-disable no-await-in-loop -- the file is written in order, one chunk at a time */
import type { FileHandle } from 'node:fs/promises';
import { open, rename, rm } from 'node:fs/promises';

import { SEQ_SPAN } from '../../chemistry/key.ts';
import { FORMAT, computeStamp } from '../../chemistry/stamp.ts';
import { SLOTS } from '../../chemistry/tile.ts';
import type { Layout } from '../layout.ts';
import type { LoadProgressListener } from '../load/loadProgress.ts';
import type { NormalizedSpec } from '../spec.ts';

import { aliveRows } from './compactRows.ts';
import type { SectionSink } from './compactSections.ts';
import { sectionSizes, writeSections } from './compactSections.ts';
import { compact, indexCountOf } from './compaction.ts';
import type { Compaction, CompactionSizes } from './compactionTypes.ts';
import type { ImagePosition } from './imagePosition.ts';
import type { SnapshotHeader } from './snapshotFile.ts';
import {
  CHUNK_BYTES,
  SNAPSHOT_VERSION,
  encodePrefix,
  fileIdentity,
  layoutConstants,
  padded,
  specDigest,
} from './snapshotFile.ts';
import { temporaryOf } from './staleSaves.ts';

/** How many of the newest molecules a snapshot names, for the store to vouch for. */
const PROBES = 4;
const MIB = 1024 * 1024;

/** What a save writes. */
export interface SaveSource {
  /** The database the image follows. */
  file: string;
  spec: NormalizedSpec;
  /** The image, holding still: freshly loaded, or its tail paused. */
  layout: Layout;
  /** Where the image stands in the file. */
  position: ImagePosition;
  /** How a load lays the image out. */
  sizes: CompactionSizes;
}

/**
 * Saves an image so that the next open reads it back in one pass, in the shape a load gives it:
 * the tail's append areas go back into their bands, and the open after catches up from the
 * image's position. It is written to a temporary file, renamed over the snapshot once complete: a
 * reader never sees half of one. A failure, such as a full disk, leaves any previous snapshot as
 * it was, and is the step's note.
 * @param path - The snapshot.
 * @param source - The image and where it stands.
 * @param listener - Hears the step, `save`, in MiB written.
 * @param signal - Stops the save between two chunks.
 * @returns Null once saved, or why it was not.
 */
export async function saveSnapshot(
  path: string,
  source: SaveSource,
  listener: LoadProgressListener,
  signal?: AbortSignal,
): Promise<string | null> {
  const temporary = temporaryOf(path);
  let total = 0;
  try {
    const compaction = compact(source.layout, source.sizes);
    const sets = source.position.sets.map((set) => set.name);
    const sections = sectionSizes(source.layout, compaction, sets.length);
    let bytes = 0;
    for (const section of sections) bytes += section;
    total = Math.ceil(bytes / MIB);
    listener({ step: 'save', done: 0, total, finished: false });
    const header = await snapshotHeader(source, compaction, sections);
    await writeSnapshot(
      temporary,
      encodePrefix(header),
      sections,
      (sink) => writeSections(sink, source.layout, compaction, sets),
      {
        signal,
        onWritten: (done) => {
          const step = { step: 'save', total, finished: false } as const;
          listener({ ...step, done: Math.floor(done / MIB) });
        },
      },
    );
    await rename(temporary, path);
    listener({ step: 'save', done: total, total, finished: true });
    return null;
  } catch (error) {
    await rm(temporary, { force: true });
    const reason = error instanceof Error ? error.message : String(error);
    const note = `not saved: ${reason}`;
    listener({ step: 'save', done: 0, total, finished: true, note });
    return note;
  }
}

async function snapshotHeader(
  source: SaveSource,
  compaction: Compaction,
  sections: number[],
): Promise<SnapshotHeader> {
  const { layout, position, spec, file } = source;
  let words = 0;
  for (const block of compaction.blocks) words += block.capacity / SLOTS;
  const rows = layout.rowCount;
  return {
    version: SNAPSHOT_VERSION,
    format: FORMAT,
    stamp: await computeStamp(),
    spec: await specDigest(spec),
    file: await fileIdentity(file),
    constants: layoutConstants(),
    layout: layout.layout,
    watermark: position.watermark,
    plan: {
      atomCounts: compaction.segments.map((segment) => segment.atoms),
      watermark: position.watermark,
      sets: position.sets,
      changeId: position.changeId,
    },
    rowSpace: compaction.rowSpace,
    rowSpaceCapacity: compaction.rowSpaceCapacity,
    histogram: { lo: layout.histogram.lo, scale: layout.histogram.scale },
    blocks: compaction.blocks.map(({ capacity, start, atoms }) => ({
      capacity,
      start,
      atoms,
      append: false,
    })),
    segments: compaction.segments.map((segment) => ({
      atoms: segment.atoms,
      bands: segment.bands,
      indexCount: indexCountOf(segment.source),
      indexed: true,
    })),
    tailFrom: compaction.segments.map((segment) =>
      segment.bands.map(
        (band) => position.tailFrom.get(segment.atoms)?.get(band.band) ?? 0,
      ),
    ),
    sets: position.sets.map((set) => set.name),
    probes: newestIds(layout),
    stats: { rows, dead: rows - aliveRows(layout, compaction), tiles: words },
    sections,
  };
}

/**
 * The ids of the newest molecules of the image: the last row of each segment's seq index, its
 * tail's when it has one.
 * @param layout - The image.
 * @returns At most PROBES ids, the newest first.
 */
function newestIds(layout: Layout): number[] {
  const newest: Array<{ seq: number; id: number }> = [];
  for (const segment of layout.segments) {
    const tail = segment.tail?.count ?? 0;
    let g = -1;
    if (segment.tail !== null && tail > 0) {
      g = new Int32Array(segment.tail.buffer, 0, tail)[tail - 1] as number;
    } else if (segment.index !== null && segment.indexCount > 0) {
      const rows = new Int32Array(segment.index, 0, segment.indexCount);
      g = rows[segment.indexCount - 1] as number;
    }
    if (g < 0) continue;
    const seq = layout.seqAt(g);
    newest.push({ seq, id: segment.atoms * SEQ_SPAN + seq });
  }
  return newest
    .toSorted((a, b) => b.seq - a.seq)
    .slice(0, PROBES)
    .map((entry) => entry.id);
}

/**
 * Writes the prefix, then the sections the body writes through the sink, each checked against
 * the length the header gives it and padded to 8 bytes; then makes the file durable.
 * @param target - The file.
 * @param prefix - The magic and the header.
 * @param expected - Each section's length, as the header gives it.
 * @param body - Writes the sections.
 * @param options - What stops the write, and who hears how far it got.
 * @param options.signal - Stops it between two chunks.
 * @param options.onWritten - Hears the bytes written so far.
 */
async function writeSnapshot(
  target: string,
  prefix: Uint8Array,
  expected: number[],
  body: (sink: SectionSink) => Promise<void>,
  options: { signal?: AbortSignal; onWritten: (bytes: number) => void },
): Promise<void> {
  const handle = await open(target, 'w');
  try {
    await writeAll(handle, prefix, 0);
    let position = prefix.length;
    let written = 0;
    let next = 0;
    await body({
      section: async (parts) => {
        const size = expected[next++];
        if (size === undefined) throw new Error('a section the header lacks');
        let length = 0;
        for (const part of parts) {
          for (let at = 0; at < part.length; at += CHUNK_BYTES) {
            if (options.signal?.aborted) throw new Error('the index closed');
            const end = Math.min(at + CHUNK_BYTES, part.length);
            await writeAll(handle, part.subarray(at, end), position + length);
            length += end - at;
            written += end - at;
            options.onWritten(written);
          }
        }
        if (length !== size) {
          throw new Error(
            `a section of ${length} bytes, the header says ${size}`,
          );
        }
        position += padded(length);
      },
    });
    if (next !== expected.length) throw new Error('a section left unwritten');
    // The last section's padding, which no write reached.
    await handle.truncate(position);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let done = 0;
  while (done < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      done,
      bytes.length - done,
      position + done,
    );
    done += bytesWritten;
  }
}
