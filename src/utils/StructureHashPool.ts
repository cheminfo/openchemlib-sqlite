import { Worker } from 'node:worker_threads';

import type { HashResponse } from '../hashWorker.ts';

import type { HashKind } from './structureHash.ts';

// Where a worker loads its code from. Running from source (`.ts`) the sibling is
// stripped in the worker thread; from the published package it is the built
// `.js` next to this module. Either way the file ships inside the package.
const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(
  FROM_SOURCE ? '../hashWorker.ts' : '../hashWorker.js',
  import.meta.url,
);
const WORKER_EXEC_ARGV = FROM_SOURCE ? ['--experimental-strip-types'] : [];

/** One molecule's outcome: its hash, or null when it has none. */
export interface HashOutcome {
  hash: string | null;
  /** True when the cap stopped it rather than OpenChemLib answering. */
  timedOut: boolean;
}

/**
 * A single hashing worker with a watchdog, replaced when a molecule runs long.
 *
 * Canonizing a generic tautomer is synchronous inside the worker and inside
 * WebAssembly, so there is nothing to cancel: the only way to stop one is to
 * destroy the thread running it. That is what makes the cap cost a worker
 * restart (~50 ms, mostly re-instantiating the wasm module) and why the cap is
 * worth having anyway — the molecules it stops would otherwise run for seconds.
 */
class HashWorker {
  #worker: Worker | undefined;
  #ready: Promise<void> | undefined;

  /**
   * Hash one idCode, giving up after `capMs`.
   * @param kind - Which hash to compute.
   * @param idCode - The molecule to hash.
   * @param capMs - How long to allow before destroying the worker.
   * @returns Its hash, or null with `timedOut` set when the cap stopped it.
   */
  async hash(
    kind: HashKind,
    idCode: string,
    capMs: number,
  ): Promise<HashOutcome> {
    const worker = await this.#ensureWorker();
    return new Promise<HashOutcome>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        // The thread is wedged in the canonizer and will never answer, so it is
        // destroyed and the next molecule gets a fresh one.
        void this.#discard();
        resolve({ hash: null, timedOut: true });
      }, capMs);

      const onMessage = (response: HashResponse) => {
        cleanup();
        resolve({ hash: response.hash, timedOut: false });
      };
      // A worker that dies on its own (an OOM in the canonizer, say) must not
      // hang the backfill: treat it exactly like the cap firing.
      const onExit = () => {
        cleanup();
        this.#worker = undefined;
        this.#ready = undefined;
        resolve({ hash: null, timedOut: true });
      };

      function cleanup() {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
      }

      worker.on('message', onMessage);
      worker.on('exit', onExit);
      worker.postMessage({ kind, idCode });
    });
  }

  /** Destroy the worker, if one is running. */
  async close(): Promise<void> {
    await this.#discard();
  }

  async #discard(): Promise<void> {
    const worker = this.#worker;
    this.#worker = undefined;
    this.#ready = undefined;
    if (worker) {
      worker.removeAllListeners();
      await worker.terminate();
    }
  }

  #ensureWorker(): Promise<Worker> {
    this.#worker ??= new Worker(WORKER_URL, { execArgv: WORKER_EXEC_ARGV });
    const worker = this.#worker;
    // The worker hashes a molecule before saying it is ready, so the wasm module
    // is already instantiated: without that wait the first molecule of every new
    // worker would be charged the ~45 ms module load and trip the cap.
    this.#ready ??= new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve());
      worker.once('error', reject);
    });
    return this.#ready.then(() => worker);
  }
}

/**
 * A fixed set of {@link HashWorker}s, handing each free one the next molecule.
 *
 * Molecules are dispatched to whichever worker is idle rather than split up
 * front, so the run self-balances: the cost per molecule spans four orders of
 * magnitude (130 µs at the median, the cap at the tail) and any static split
 * would leave most workers idle behind one slow one.
 */
export class StructureHashPool {
  readonly #workers: HashWorker[];
  readonly #idle: HashWorker[];
  readonly #waiting: Array<(worker: HashWorker) => void> = [];

  /**
   * Create a pool (each worker is spawned lazily, on its first molecule).
   * @param size - How many workers to run (clamped to >= 1).
   */
  constructor(size: number) {
    const count = Math.max(1, Math.trunc(size));
    this.#workers = Array.from({ length: count }, () => new HashWorker());
    this.#idle = [...this.#workers];
  }

  /**
   * Hash one idCode on the next free worker.
   * @param kind - Which hash to compute.
   * @param idCode - The molecule to hash.
   * @param capMs - How long to allow before destroying the worker running it.
   * @returns Its hash, or null with `timedOut` set when the cap stopped it.
   */
  async hash(
    kind: HashKind,
    idCode: string,
    capMs: number,
  ): Promise<HashOutcome> {
    const worker = await this.#acquire();
    try {
      return await worker.hash(kind, idCode, capMs);
    } finally {
      this.#release(worker);
    }
  }

  /** Destroy every worker. */
  async close(): Promise<void> {
    await Promise.all(this.#workers.map((worker) => worker.close()));
  }

  #acquire(): Promise<HashWorker> {
    const free = this.#idle.pop();
    if (free) return Promise.resolve(free);
    return new Promise<HashWorker>((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  #release(worker: HashWorker): void {
    const next = this.#waiting.shift();
    if (next) next(worker);
    else this.#idle.push(worker);
  }
}
