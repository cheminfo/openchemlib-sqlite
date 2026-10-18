import type { LoadProgressListener } from '../load/loadProgress.ts';
import type { NormalizedSpec } from '../spec.ts';
import type { Tail } from '../tail/Tail.ts';
import type { TailCheckpoint, TailCounters } from '../tail/tailState.ts';

import type { CompactionSizes } from './compactionTypes.ts';
import { positionOfCheckpoint } from './imagePosition.ts';
import { saveSnapshot } from './saveSnapshot.ts';

/** What a keeper saves, where, and when. */
export interface KeeperOptions {
  /** The snapshot. */
  path: string;
  /** The database. */
  file: string;
  spec: NormalizedSpec;
  tail: Tail;
  /** How a load lays the image out. */
  sizes: CompactionSizes;
  /** The share of the snapshot's rows the tail takes in before it is saved again. */
  refreshShare: number;
  /** Hears each save, as the step `save`. */
  listener: LoadProgressListener;
  /** The rows the snapshot holds. */
  rows: number;
}

/**
 * Keeps an index's snapshot close to the image. Once the tail has placed, or read again from the
 * change log, `refreshShare` of the snapshot's rows and has caught up with the file, it pauses
 * while the image is saved in the shape a load gives it; the next open catches up from there.
 */
export class SnapshotKeeper {
  readonly #options: KeeperOptions;
  /** The rows the snapshot holds. */
  #rows: number;
  /** The tail's counters at the snapshot's position. */
  #basis = { rows: 0, changes: 0 };
  #saving: Promise<string | null> | null = null;
  #closed = false;
  readonly #abort = new AbortController();

  /**
   * A keeper of a snapshot the index was just read back from, or just saved to.
   * @param options - The snapshot, the tail, and when to save again.
   */
  constructor(options: KeeperOptions) {
    this.#options = options;
    this.#rows = options.rows;
  }

  /**
   * Hears the tail's counters: saves again once it took in enough and caught up.
   * @param counters - What the tail took in so far.
   */
  onCounters(counters: TailCounters): void {
    if (counters.more || this.#saving !== null || this.#closed) return;
    const taken =
      counters.rows -
      this.#basis.rows +
      (counters.changes - this.#basis.changes);
    if (taken < this.#options.refreshShare * Math.max(1, this.#rows)) return;
    void this.save();
  }

  /**
   * Saves the image now, the tail paused meanwhile; a save running is joined.
   * @returns Null once saved, or why it was not.
   */
  save(): Promise<string | null> {
    if (this.#closed) return Promise.resolve('not saved: the index closed');
    this.#saving ??= this.#save().finally(() => {
      this.#saving = null;
    });
    return this.#saving;
  }

  /** Stops a save running, which then leaves the snapshot as it was. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort();
    await this.#saving;
  }

  async #save(): Promise<string | null> {
    try {
      return await this.#savePaused();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return refuse(this.#options.listener, reason);
    }
  }

  async #savePaused(): Promise<string | null> {
    const { tail, listener, spec, path, file, sizes } = this.#options;
    const checkpoint = await tail.pause();
    try {
      const reason = unsavable(checkpoint, tail, spec);
      const note =
        reason === null
          ? await saveSnapshot(
              path,
              {
                file,
                spec,
                layout: tail.current,
                position: positionOfCheckpoint(checkpoint),
                sizes,
              },
              listener,
              this.#abort.signal,
            )
          : refuse(listener, reason);
      // Saved or not, the next save waits until the tail took in as much again.
      this.#basis = {
        rows: checkpoint.counters.rows,
        changes: checkpoint.counters.changes,
      };
      if (note === null) this.#rows = tail.current.rowCount;
      return note;
    } finally {
      if (!this.#closed) await tail.resume();
    }
  }
}

/**
 * Why an image cannot be saved: a tail stopped mid-poll may have placed rows no version holds, and
 * an image no longer following the change log misses changes the snapshot would claim.
 * @param checkpoint - Where the tail stands.
 * @param tail - The tail.
 * @param spec - The specification.
 * @returns The reason, or null.
 */
function unsavable(
  checkpoint: TailCheckpoint,
  tail: Tail,
  spec: NormalizedSpec,
): string | null {
  if (checkpoint.fatal !== null) return checkpoint.fatal;
  if (spec.changes !== null && checkpoint.changeId === null) {
    return 'the index no longer follows the change log';
  }
  if (tail.current.version !== checkpoint.version) {
    return 'the tail published past its pause';
  }
  return null;
}

function refuse(listener: LoadProgressListener, reason: string): string {
  const note = `not saved: ${reason}`;
  listener({ step: 'save', done: 0, total: 0, finished: true, note });
  return note;
}
