import { FORMAT, computeStamp } from '../../chemistry/stamp.ts';
import { readMeta } from '../../store/schema.ts';
import { columnLayout } from '../blocks.ts';
import { openReader, readLastChange } from '../load/plan.ts';
import type { NormalizedSpec } from '../spec.ts';

import type { SnapshotHeader } from './snapshotFile.ts';
import {
  SNAPSHOT_VERSION,
  blockBytes,
  fileIdentity,
  layoutConstants,
  snapshotBytes,
  specDigest,
} from './snapshotFile.ts';

/** What a snapshot is checked against. */
export interface SnapshotContext {
  /** The database the index is opened on. */
  file: string;
  spec: NormalizedSpec;
  /** The share of its rows the store may have moved past it. */
  staleShare: number;
  /** The snapshot's length in bytes. */
  fileBytes: number;
  /** Its header's length in bytes. */
  headerBytes: number;
}

/**
 * Why a snapshot cannot be used, or null when it can: saved by another build or under another
 * specification, from another database file, cut short, or no longer something the tail can
 * catch up from.
 * @param header - The snapshot's header.
 * @param context - What it is checked against.
 * @returns The reason, or null.
 */
export async function refusalOf(
  header: SnapshotHeader,
  context: SnapshotContext,
): Promise<string | null> {
  if (header.version !== SNAPSHOT_VERSION) {
    return `saved in snapshot format ${header.version}, this build reads ${SNAPSHOT_VERSION}`;
  }
  if (header.format !== FORMAT || header.stamp !== (await computeStamp())) {
    return 'saved by another build of openchemlib-sqlite';
  }
  if (header.spec !== (await specDigest(context.spec))) {
    return 'saved under another specification';
  }
  if (
    !sameJson(header.constants, layoutConstants()) ||
    !sameJson(header.layout, columnLayout(context.spec.filters))
  ) {
    return 'laid out with other constants';
  }
  const identity = await fileIdentity(context.file);
  if (identity.ino !== header.file.ino) {
    return 'saved from another database file';
  }
  if (snapshotBytes(header, context.headerBytes) !== context.fileBytes) {
    return 'cut short';
  }
  if (!sectionsFit(header)) return 'its sections do not match its blocks';
  return storeRefusal(header, context);
}

/**
 * Whether the store can still bring the snapshot up to date: it holds every molecule the snapshot
 * does, its change log reaches back to the snapshot, and it has not grown too far past it.
 * @param header - The snapshot's header.
 * @param context - What it is checked against.
 * @returns The reason it cannot, or null.
 */
function storeRefusal(
  header: SnapshotHeader,
  context: SnapshotContext,
): string | null {
  const db = openReader(context.file);
  try {
    db.exec('BEGIN');
    const top = readMeta(db).seq;
    if (top < header.watermark) return 'the store is older than it';
    const { changes } = context.spec;
    const changeId = header.plan.changeId;
    if (changes !== null && changeId !== null) {
      const last = readLastChange(db, changes.last);
      if (last < changeId) return 'the change log is older than it';
      // Changes after the snapshot must all still be in the log, which may be pruned.
      const first = readLastChange(db, changes.first);
      if (last > changeId && (first === 0 || first > changeId + 1)) {
        return 'the change log no longer reaches back to it';
      }
    }
    // A store rolled back lacks all of them; one removed since is no reason to load again.
    const probe = db.prepare('SELECT 1 FROM ocl_molecule WHERE id = ?');
    let found = 0;
    for (const id of header.probes) {
      if (probe.get(id) !== undefined) found++;
    }
    if (header.probes.length > 0 && found === 0) {
      return 'its newest molecules are not in the store';
    }
    const behind = top - header.watermark;
    if (behind > context.staleShare * Math.max(1, header.stats.rows)) {
      return `${behind} molecules behind the store`;
    }
    return null;
  } finally {
    if (db.isTransaction) db.exec('COMMIT');
    db.close();
  }
}

function sectionsFit(header: SnapshotHeader): boolean {
  const indexed = header.segments.filter((segment) => segment.indexed).length;
  const expected = 2 * header.blocks.length + indexed + 3 + header.sets.length;
  if (header.sections.length !== expected) return false;
  for (const [b, block] of header.blocks.entries()) {
    const { planes, columns } = blockBytes(block.capacity, header.layout);
    if (header.sections[2 * b] !== planes) return false;
    if (header.sections[2 * b + 1] !== columns) return false;
  }
  return true;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
