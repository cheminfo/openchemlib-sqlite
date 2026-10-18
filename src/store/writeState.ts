import type { DatabaseSync } from 'node:sqlite';

import type { Signatures } from '../chemistry/stamp.ts';

import type { Counting } from './bitCounts.ts';
import { countingOf } from './bitCounts.ts';
import { readMeta, staleTiles } from './schema.ts';

/** What a store knows of its file between writes. */
export interface WriteState {
  /** The file's generation when the store last looked. */
  generation: number;
  /** The fingerprints whose bit counts its writes keep. */
  counting: Counting;
}

/** What a write does besides its own rows. */
export interface WriteCheck {
  /** The fingerprints whose bit counts it keeps. */
  counting: Counting;
  /**
   * Whether a rebuild is under way: the write logs each tile it changes and each molecule it
   * removes, for the rebuild to bring its own tiles up to date before it switches.
   */
  logging: boolean;
}

/**
 * Refuses a write once the file was rebuilt for another build; a file rebuilt for this same build
 * (its bits counted again) is taken as it now is. While a rebuild is under way, writes go on and
 * log what they change.
 * @param db - The connection, inside the write transaction.
 * @param state - The store's state, brought up to date.
 * @param stamp - The store's stamp.
 * @param signatures - The store's signatures.
 * @returns What the write does besides its own rows.
 */
export function checkWritable(
  db: DatabaseSync,
  state: WriteState,
  stamp: string,
  signatures: Signatures,
): WriteCheck {
  const meta = readMeta(db);
  if (meta.generation !== state.generation) {
    const stored = meta.signatures;
    if (
      meta.stamp !== stamp ||
      stored?.identity !== signatures.identity ||
      staleTiles(stored, signatures).length > 0
    ) {
      throw new Error(
        'the file was rebuilt for another build since this store opened: open it with that build',
      );
    }
    state.generation = meta.generation;
    state.counting = countingOf(meta.counted, signatures);
  }
  return { counting: state.counting, logging: meta.rebuild !== '' };
}
