import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';

import { readHeader } from './readHeader.ts';

/** Where a snapshot stands in its database. */
export interface SnapshotPosition {
  /** It holds every molecule with a seq up to it. */
  watermark: number;
  /** The last change of the log it applied, null without a change log. */
  changeId: number | null;
}

/**
 * Where a snapshot stands, from its header alone. An application pruning its change log keeps
 * the changes after `changeId`: the next open then catches up from the snapshot instead of
 * loading the index from the tables again.
 * @param path - The snapshot.
 * @returns Its position, or null when there is none or the file is not a snapshot.
 */
export async function readSnapshotPosition(
  path: string,
): Promise<SnapshotPosition | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const read = await readHeader(handle);
    if (read === null) return null;
    return {
      watermark: read.header.watermark,
      changeId: read.header.plan.changeId,
    };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
