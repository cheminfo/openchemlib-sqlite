import { Worker } from 'node:worker_threads';

import type {
  InputFormat,
  MoleculesDBConfig,
  SearchResponse,
  SearchResult,
} from './types.ts';

/** Options to create a {@link SearchWorkerPool}. */
export interface SearchWorkerPoolOptions {
  /** Path to the SQLite file each worker opens. */
  dbPath: string;
  /** Column config (no `dbPath`/`poolSize`) for the worker's index. */
  config: MoleculesDBConfig;
  /** Number of worker threads (clamped to >= 1). */
  poolSize: number;
}

/** Options for one parallel substructure scan. */
export interface PoolScanOptions {
  format: InputFormat;
  from: number;
  limit: number;
  timeoutMs: number;
  /** Query molecular weight, for the merge sort (when the DB has an mw column). */
  queryMw: number;
  /** Whether to sort the merged results by mass proximity to `queryMw`. */
  sortByMw: boolean;
  onProgress?: (processed: number, total: number) => void;
}

interface WorkerMessage {
  type: 'progress' | 'done' | 'error';
  id: number;
  index?: number;
  processed?: number;
  total?: number;
  results?: SearchResult[];
  screened?: number;
  partial?: boolean;
  message?: string;
}

// The worker file sits next to this module; its extension matches whether we run
// from source (.ts) or the built package (.js) — `new URL` is not rewritten by
// the TypeScript build, so the extension is derived from this module's own URL.
const WORKER_EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const WORKER_URL = new URL(`searchWorker${WORKER_EXT}`, import.meta.url);

/**
 * Pool of worker threads that run a substructure scan in parallel by partitioning
 * the entries across workers (`pk % poolSize`). Each worker opens its own
 * read-only connection, so the calling thread is never blocked. Scans are
 * serialized through the pool, so progress and results never interleave.
 */
export class SearchWorkerPool {
  readonly #dbPath: string;
  readonly #config: MoleculesDBConfig;
  readonly #size: number;
  #workers: Worker[] | undefined;
  #nextId = 1;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * Create a pool (workers are spawned lazily on first search).
   * @param options - The database path, column config, and worker count.
   */
  constructor(options: SearchWorkerPoolOptions) {
    this.#dbPath = options.dbPath;
    this.#config = options.config;
    this.#size = Math.max(1, Math.trunc(options.poolSize));
  }

  /**
   * Run a substructure scan across the pool and return the merged response.
   * @param query - Query string (an idCode, so it is cheap to transfer).
   * @param options - Format, pagination, mw sort key, and progress callback.
   * @returns The merged, sorted, paginated search response.
   */
  runSubstructure(
    query: string,
    options: PoolScanOptions,
  ): Promise<SearchResponse> {
    // Serialize scans so one scan's messages never interleave with another's.
    const run = this.#queue.then(() => this.#scanOnce(query, options));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Terminate every worker. Safe to call when none were spawned. */
  async close(): Promise<void> {
    const workers = this.#workers;
    this.#workers = undefined;
    if (workers) await Promise.all(workers.map((worker) => worker.terminate()));
  }

  #ensureWorkers(): Worker[] {
    if (this.#workers) return this.#workers;
    this.#workers = Array.from(
      { length: this.#size },
      () =>
        new Worker(WORKER_URL, {
          workerData: { dbPath: this.#dbPath, config: this.#config },
          // The parent may run under flags a worker cannot inherit (e.g.
          // --watch); pass only type stripping so a .ts worker still loads.
          execArgv: WORKER_EXT === '.ts' ? ['--experimental-strip-types'] : [],
        }),
    );
    return this.#workers;
  }

  #scanOnce(query: string, options: PoolScanOptions): Promise<SearchResponse> {
    const workers = this.#ensureWorkers();
    const size = workers.length;
    const id = this.#nextId++;
    const { from, limit, timeoutMs, format, queryMw, sortByMw, onProgress } =
      options;

    // All mutable state for this scan lives in one const object so the message
    // handler (defined once, outside the worker loop) closes over a stable
    // binding rather than per-iteration `let`s.
    const state = {
      progress: Array.from({ length: size }, () => ({ p: 0, t: 0 })),
      merged: [] as SearchResult[],
      listeners: new Map<Worker, (message: WorkerMessage) => void>(),
      total: 0,
      screened: 0,
      partial: false,
      remaining: size,
      settled: false,
    };

    const cleanup = () => {
      for (const [worker, listener] of state.listeners) {
        worker.off('message', listener);
      }
    };

    return new Promise<SearchResponse>((resolve, reject) => {
      const handle = (index: number, message: WorkerMessage) => {
        if (message.id !== id) return;
        if (message.type === 'progress') {
          state.progress[index] = {
            p: message.processed ?? 0,
            t: message.total ?? 0,
          };
          if (onProgress) {
            let processed = 0;
            let totalCandidates = 0;
            for (const entry of state.progress) {
              processed += entry.p;
              totalCandidates += entry.t;
            }
            onProgress(processed, totalCandidates);
          }
          return;
        }
        if (state.settled) return;
        if (message.type === 'error') {
          state.settled = true;
          cleanup();
          reject(new Error(message.message ?? 'substructure worker failed'));
          return;
        }
        state.merged.push(...(message.results ?? []));
        state.total += message.total ?? 0;
        state.screened += message.screened ?? 0;
        state.partial = state.partial || (message.partial ?? false);
        state.remaining -= 1;
        if (state.remaining === 0) {
          state.settled = true;
          cleanup();
          const sorted = sortByMw
            ? state.merged.toSorted(
                (a, b) =>
                  Math.abs((a.mw ?? 0) - queryMw) -
                  Math.abs((b.mw ?? 0) - queryMw),
              )
            : state.merged;
          resolve({
            results: sorted.slice(from, from + limit),
            total: state.total,
            screened: state.screened,
            partial: state.partial,
          });
        }
      };

      for (const [index, worker] of workers.entries()) {
        const listener = (message: WorkerMessage) => handle(index, message);
        state.listeners.set(worker, listener);
        worker.on('message', listener);
        worker.postMessage({
          id,
          query,
          format,
          limit: Number.MAX_SAFE_INTEGER,
          timeoutMs,
          partition: { count: size, index },
        });
      }
    });
  }
}
