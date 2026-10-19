import { Worker } from 'node:worker_threads';

import { isReply } from '../../workerReplies.ts';

import type {
  ControlReply,
  IndexedBlock,
  PhaseMessage,
  PhaseReply,
  SearchWorkerData,
} from './messages.ts';
import { WATCH } from './messages.ts';
import type { SearchPoolOptions } from './poolTypes.ts';

const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(
  FROM_SOURCE ? 'searchWorker.ts' : 'searchWorker.js',
  import.meta.url,
);
const WATCHDOG_POLL_MS = 25;
/** The `type` of every message a search worker posts. */
const SEARCH_REPLIES: ReadonlySet<unknown> = new Set([
  'ready',
  'idle',
  'screened',
  'verified',
  'sim',
  'counted',
]);
const watchNow = () => performance.timeOrigin + performance.now();

/** A verification call the watchdog killed. */
export interface Kill {
  slot: number;
  /** The phase it belonged to. */
  gen: number;
  /** Its first candidate, how many it held, the end of the range it belongs to, alone or not. */
  at: number;
  count: number;
  rangeEnd: number;
  single: boolean;
}

/** What the slots tell the pool. */
export interface SlotEvents {
  /** A reply of a phase. */
  onReply: (reply: PhaseReply) => void;
  /** A worker failed: the pool fails. */
  onError: (error: Error) => void;
  /** A worker (a first one, or one respawned after a kill) is ready. */
  onReady: (slot: number) => void;
  /** The watchdog killed a call. */
  onKill: (kill: Kill) => void;
}

/**
 * The search worker threads and their watchdog: before each wasm call a worker writes in its watch
 * slot when the call may be killed and which candidates it holds; a worker still in that call past
 * it is terminated and respawned in the same slot.
 */
export class WorkerSlots {
  /** The phase under way, as the workers read it. */
  readonly control = new Int32Array(new SharedArrayBuffer(4));
  readonly #watch: Float64Array;
  readonly #options: SearchPoolOptions;
  readonly #events: SlotEvents;
  readonly #workers: Array<Worker | null>;
  readonly #readyWaiters = new Map<number, () => void>();
  readonly #respawns = new Map<number, Promise<void>>();
  readonly #blocks: IndexedBlock[];
  readonly #watchdog: ReturnType<typeof setInterval>;
  /** Resolves once every worker is ready. */
  readonly ready: Promise<void>;

  /**
   * Starts the workers and the watchdog.
   * @param options - Threads, the file, the column layout and the blocks.
   * @param events - What the pool hears.
   */
  constructor(options: SearchPoolOptions, events: SlotEvents) {
    this.#options = options;
    this.#events = events;
    this.#watch = new Float64Array(
      new SharedArrayBuffer(8 * WATCH * Math.max(1, options.threads)),
    );
    this.#workers = new Array<Worker | null>(options.threads).fill(null);
    this.#blocks = options.blocks.slice();
    this.ready = Promise.all(
      Array.from({ length: options.threads }, (_, slot) => this.#spawn(slot)),
    ).then(() => undefined);
    this.#watchdog = setInterval(() => this.#checkWatch(), WATCHDOG_POLL_MS);
    this.#watchdog.unref();
  }

  /**
   * Posts a phase to one worker, if it is live.
   * @param slot - The worker.
   * @param message - The phase.
   */
  post(slot: number, message: PhaseMessage): void {
    this.#workers[slot]?.postMessage(message);
  }

  /**
   * Posts a phase to every live worker.
   * @param message - The phase.
   */
  postAll(message: PhaseMessage): void {
    for (let slot = 0; slot < this.#workers.length; slot++) {
      this.post(slot, message);
    }
  }

  /**
   * Blocks the tail published: every live worker, and every one spawned later, holds them.
   * @param added - The new blocks.
   */
  addBlocks(added: IndexedBlock[]): void {
    if (added.length === 0) return;
    for (const block of added) this.#blocks[block.index] = block;
    for (const worker of this.#workers) {
      worker?.postMessage({ type: 'blocks', add: added });
    }
  }

  /**
   * Verification calls of a phase still running.
   * @param gen - The phase.
   * @returns How many.
   */
  runningCalls(gen: number): number {
    let running = 0;
    for (let slot = 0; slot < this.#workers.length; slot++) {
      const base = WATCH * slot;
      if ((this.#watch[base] as number) > 0 && this.#watch[base + 1] === gen) {
        running++;
      }
    }
    return running;
  }

  /**
   * Resolves once no slot is being respawned.
   * @returns When every killed worker has a successor.
   */
  async settled(): Promise<void> {
    while (this.#respawns.size > 0) {
      // eslint-disable-next-line no-await-in-loop -- a respawn may start while others finish
      await Promise.all(this.#respawns.values());
    }
  }

  /**
   * Stops the watchdog and the workers.
   * @returns Once they are stopped.
   */
  async close(): Promise<void> {
    clearInterval(this.#watchdog);
    await this.settled();
    await Promise.all(
      this.#workers.flatMap((worker) =>
        worker === null ? [] : [worker.terminate()],
      ),
    );
  }

  #spawn(slot: number): Promise<void> {
    const blocks = this.#blocks.filter((block) => block !== undefined);
    const workerData: SearchWorkerData = {
      file: this.#options.file,
      layout: this.#options.layout,
      columnsSql: this.#options.columnsSql,
      control: this.control.buffer,
      watch: this.#watch.buffer as SharedArrayBuffer,
      blocks,
      worker: slot,
    };
    const thread = new Worker(WORKER_URL, { workerData });
    thread.on('message', (posted: unknown) => {
      // Only the pool's replies: Node's watch mode posts messages of its own.
      if (!isReply(posted, 'type', SEARCH_REPLIES)) return;
      const message = posted as unknown as PhaseReply | ControlReply;
      if (message.type === 'idle') return;
      if (message.type === 'ready') {
        this.#readyWaiters.get(message.worker)?.();
        this.#readyWaiters.delete(message.worker);
      } else {
        this.#events.onReply(message);
      }
    });
    thread.on('error', (error: Error) => this.#events.onError(error));
    return new Promise((resolve, reject) => {
      // A worker gone before it is ready fails the pool, rather than leaving it waiting.
      const fail = (error: Error) => {
        if (!this.#readyWaiters.delete(slot)) return;
        this.#events.onError(error);
        reject(error);
      };
      thread.once('error', fail);
      thread.once('exit', (code) =>
        fail(new Error(`a worker exited (${code})`)),
      );
      this.#readyWaiters.set(slot, () => {
        // The blocks the tail published while it started, ahead of any phase.
        const missed = this.#blocks.filter(
          (block) => block !== undefined && !blocks.includes(block),
        );
        thread.postMessage({ type: 'blocks', add: missed });
        this.#workers[slot] = thread;
        resolve();
        this.#events.onReady(slot);
      });
    });
  }

  #checkWatch(): void {
    const now = watchNow();
    for (let slot = 0; slot < this.#workers.length; slot++) {
      const killAt = this.#watch[WATCH * slot] as number;
      if (killAt > 0 && now > killAt && this.#workers[slot] !== null) {
        this.#kill(slot);
      }
    }
  }

  #kill(slot: number): void {
    const base = WATCH * slot;
    const kill: Kill = {
      slot,
      gen: this.#watch[base + 1] as number,
      at: this.#watch[base + 2] as number,
      count: this.#watch[base + 3] as number,
      rangeEnd: this.#watch[base + 4] as number,
      single: this.#watch[base + 5] === 1,
    };
    this.#watch[base] = 0;
    const thread = this.#workers[slot] as Worker;
    this.#workers[slot] = null;
    // A successor that fails is reported through onError: the pool then refuses every search.
    const respawn = thread
      .terminate()
      .then(() => this.#spawn(slot))
      .catch(() => undefined);
    this.#respawns.set(
      slot,
      respawn.finally(() => this.#respawns.delete(slot)),
    );
    this.#events.onKill(kill);
  }
}
