/* eslint-disable no-await-in-loop -- a file is read in order, one chunk at a time */
import type { FileHandle } from 'node:fs/promises';

import type { SnapshotHeader } from './snapshotFile.ts';
import {
  CHUNK_BYTES,
  decodeHeader,
  headerLength,
  headerStart,
} from './snapshotFile.ts';

/** A header longer than this is not one: the file is not a snapshot. */
const MAX_HEADER_BYTES = 1024 * 1024 * 1024;

/**
 * A snapshot's header.
 * @param handle - The snapshot, open.
 * @returns The header and its length in bytes, or null when the file is not a snapshot.
 */
export async function readHeader(
  handle: FileHandle,
): Promise<{ header: SnapshotHeader; length: number } | null> {
  const prefix = new Uint8Array(headerStart());
  await readFully(handle, prefix, 0, noop);
  const length = headerLength(prefix);
  if (length < 0 || length > MAX_HEADER_BYTES) return null;
  const text = new Uint8Array(length);
  await readFully(handle, text, headerStart(), noop);
  return { header: decodeHeader(text), length };
}

/**
 * Fills a buffer from a file, in chunks.
 * @param handle - The file.
 * @param target - The buffer.
 * @param position - Where the read starts in the file.
 * @param onRead - Hears the bytes read so far.
 */
export async function readFully(
  handle: FileHandle,
  target: Uint8Array,
  position: number,
  onRead: (bytes: number) => void,
): Promise<void> {
  let done = 0;
  while (done < target.length) {
    const length = Math.min(CHUNK_BYTES, target.length - done);
    const { bytesRead } = await handle.read(
      target,
      done,
      length,
      position + done,
    );
    if (bytesRead === 0) throw new Error('the file ended early');
    done += bytesRead;
    onRead(done);
  }
}

function noop(): void {
  // Nothing to report for the header.
}
