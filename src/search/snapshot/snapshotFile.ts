import { stat } from 'node:fs/promises';

import { SEQ_SPAN } from '../../chemistry/key.ts';
import { PLANES, SLOTS } from '../../chemistry/tile.ts';
import type { ColumnLayout } from '../blocks.ts';
import type { Band } from '../layoutTypes.ts';
import type { LoadPlan } from '../load/plan.ts';
import type { NormalizedSpec } from '../spec.ts';
import { ZONE_BYTES } from '../zones.ts';

/** The first bytes of a snapshot. */
export const MAGIC = 'ocl-sqlite index';
/** Bumped whenever what a snapshot holds, or how it lays it out, changes. */
export const SNAPSHOT_VERSION = 2;
/** Bytes read or written at a time: large, so the file is streamed in order. */
export const CHUNK_BYTES = 32 * 1024 * 1024;
/** The magic, then the header's length as a little-endian uint32. */
const PREFIX_BYTES = MAGIC.length + 4;

/** The database file a snapshot was saved from. */
export interface FileIdentity {
  /**
   * Its inode. Birth times are left out: where a file system has none, Node reports the change
   * time instead, which every write moves.
   */
  ino: string;
}

/** What a snapshot says of itself, ahead of its sections. */
export interface SnapshotHeader {
  version: number;
  format: string;
  stamp: string;
  /** SHA-256 of the normalized specification. */
  spec: string;
  file: FileIdentity;
  constants: Record<string, number>;
  layout: ColumnLayout;
  watermark: number;
  plan: LoadPlan;
  rowSpace: number;
  rowSpaceCapacity: number;
  histogram: { lo: number; scale: number };
  blocks: Array<{
    capacity: number;
    start: number;
    atoms: number;
    append: boolean;
  }>;
  segments: Array<{
    atoms: number;
    bands: Band[];
    indexCount: number;
    indexed: boolean;
  }>;
  /** Per segment, per band: the first tile the tail reads. */
  tailFrom: number[][];
  /** The sets' names, in the order of their sections. */
  sets: string[];
  /** Ids of the newest molecules of the image, which the store must still hold. */
  probes: number[];
  stats: { rows: number; dead: number; tiles: number };
  /** Byte lengths of the sections, in file order. */
  sections: number[];
}

/**
 * The constants the image's buffers are laid out with.
 * @returns Them, by name.
 */
export function layoutConstants(): Record<string, number> {
  return {
    planes: PLANES,
    slots: SLOTS,
    seqSpan: SEQ_SPAN,
    zoneBytes: ZONE_BYTES,
  };
}

/**
 * The identity of a database file: a copy is another file.
 * @param file - The database.
 * @returns Its inode.
 */
export async function fileIdentity(file: string): Promise<FileIdentity> {
  const stats = await stat(file, { bigint: true });
  return { ino: String(stats.ino) };
}

/**
 * A digest of the specification, so a snapshot made under another one is refused.
 * @param spec - The normalized specification.
 * @returns Its SHA-256, in hex.
 */
export async function specDigest(spec: NormalizedSpec): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(spec));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * The bytes ahead of the sections: the magic, the header's length, the header, then zeros up to a
 * multiple of 64.
 * @param header - The header.
 * @returns The prefix.
 */
export function encodePrefix(header: SnapshotHeader): Uint8Array {
  // JSON writes Infinity and NaN as null: an empty band's zone bounds are infinite.
  const json = JSON.stringify(header, (_key, value: unknown) =>
    typeof value === 'number' && !Number.isFinite(value)
      ? { $number: String(value) }
      : value,
  );
  const text = new TextEncoder().encode(json);
  const prefix = new Uint8Array(dataStart(text.length));
  prefix.set(new TextEncoder().encode(MAGIC));
  new DataView(prefix.buffer).setUint32(MAGIC.length, text.length, true);
  prefix.set(text, PREFIX_BYTES);
  return prefix;
}

/**
 * The header's length, from the first bytes of a file.
 * @param prefix - At least the magic and the length.
 * @returns The length, or -1 when the file is not a snapshot.
 */
export function headerLength(prefix: Uint8Array): number {
  if (prefix.length < PREFIX_BYTES) return -1;
  const magic = new TextDecoder().decode(prefix.subarray(0, MAGIC.length));
  if (magic !== MAGIC) return -1;
  return new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  ).getUint32(MAGIC.length, true);
}

/**
 * The header, from its bytes.
 * @param bytes - The header's JSON.
 * @returns It.
 */
export function decodeHeader(bytes: Uint8Array): SnapshotHeader {
  return JSON.parse(new TextDecoder().decode(bytes), (_key, value: unknown) =>
    isEncodedNumber(value) ? Number(value.$number) : value,
  ) as SnapshotHeader;
}

/**
 * Where the header starts in the file.
 * @returns The offset.
 */
export function headerStart(): number {
  return PREFIX_BYTES;
}

/**
 * Where the sections start, after a header of that length.
 * @param length - The header's length.
 * @returns The offset, a multiple of 64.
 */
export function dataStart(length: number): number {
  return Math.ceil((PREFIX_BYTES + length) / 64) * 64;
}

/**
 * A section's length rounded up, so the next one starts on a multiple of 8.
 * @param bytes - Its length.
 * @returns The rounded length.
 */
export function padded(bytes: number): number {
  return Math.ceil(bytes / 8) * 8;
}

/**
 * The length of a whole snapshot.
 * @param header - Its header.
 * @param length - The header's length in bytes.
 * @returns The file's length.
 */
export function snapshotBytes(header: SnapshotHeader, length: number): number {
  let bytes = dataStart(length);
  for (const section of header.sections) bytes += padded(section);
  return bytes;
}

/**
 * The lengths a block's two sections must have.
 * @param capacity - Its rows.
 * @param layout - The column layout.
 * @returns The planes' and the columns' bytes.
 */
export function blockBytes(
  capacity: number,
  layout: ColumnLayout,
): { planes: number; columns: number } {
  const words = capacity / SLOTS;
  return {
    planes: PLANES * words * 4,
    columns: capacity * layout.rowBytes + ZONE_BYTES * words,
  };
}

function isEncodedNumber(value: unknown): value is { $number: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$number' in value &&
    Object.keys(value).length === 1
  );
}
