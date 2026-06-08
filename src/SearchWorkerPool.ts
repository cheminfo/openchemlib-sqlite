import type { Pool } from 'workerpool';
import { pool } from 'workerpool';

import type { PartitionResult, PartitionTask } from './searchWorker.ts';
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
  /**
   * Number of worker threads (clamped to >= 1).
   * @default 4
   */
  poolSize?: number;
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

interface ProgressEvent {
  type: 'progress';
  index: number;
  processed: number;
  total: number;
}

/** The subset of the worker module the offloaded bootstrap calls. */
interface SearchWorkerModule {
  runSearchPartition: (task: PartitionTask) => Promise<PartitionResult>;
}

// Where each worker re-imports the partition logic from. From the published
// package (this module is `.js` inside node_modules) a bare subpath specifier
// keeps the worker self-contained and survives bundling; from source (`.ts`) we
// point at the sibling file and strip types in the worker thread. Either way the
// worker code ships inside the package — there is no loose file to discover.
const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_MODULE = FROM_SOURCE
  ? new URL('searchWorker.ts', import.meta.url).href
  : 'openchemlib-sqlite/worker';
const WORKER_EXEC_ARGV = FROM_SOURCE ? ['--experimental-strip-types'] : [];

// Offloaded to each workerpool worker. It is stringified and re-evaluated in the
// worker, so it must be fully self-contained: it only reads `task` and imports
// the worker module by the specifier the pool chose. Keeping it to a single
// import + call avoids any reliance on this module's scope.
function runPartition(task: PartitionTask): Promise<PartitionResult> {
  // Build the dynamic import through `new Function` so bundlers (Vite, esbuild,
  // …) cannot see or rewrite the `import()` — this function is stringified and
  // re-evaluated in a bare worker where only the native `import()` exists, not a
  // bundler's internal helper.
  // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- intentional: hide import() from bundlers
  const importModule = new Function(
    'specifier',
    'return import(specifier);',
  ) as (specifier: string) => Promise<SearchWorkerModule>;
  return importModule(task.workerModule).then((module) =>
    module.runSearchPartition(task),
  );
}

/**
 * Pool of worker threads that run a substructure scan in parallel by partitioning
 * the entries across workers (`pk % poolSize`). Each worker opens its own
 * connection, so the calling thread is never blocked. The pool itself is managed
 * by `workerpool`, which runs on both Node.js and the browser.
 */
export class SearchWorkerPool {
  readonly #dbPath: string;
  readonly #config: MoleculesDBConfig;
  readonly #size: number;
  #pool: Pool | undefined;

  /**
   * Create a pool (workers are spawned lazily on first search).
   * @param options - The database path, column config, and worker count.
   */
  constructor(options: SearchWorkerPoolOptions) {
    this.#dbPath = options.dbPath;
    this.#config = options.config;
    this.#size = Math.max(1, Math.trunc(options.poolSize ?? 4));
  }

  /**
   * Run a substructure scan across the pool and return the merged response.
   * @param query - Query string (an idCode, so it is cheap to transfer).
   * @param options - Format, pagination, mw sort key, and progress callback.
   * @returns The merged, sorted, paginated search response.
   */
  async runSubstructure(
    query: string,
    options: PoolScanOptions,
  ): Promise<SearchResponse> {
    const workerPool = this.#ensurePool();
    const size = this.#size;
    const { from, limit, timeoutMs, format, queryMw, sortByMw, onProgress } =
      options;

    const progress = Array.from({ length: size }, () => ({
      processed: 0,
      total: 0,
    }));
    const reportProgress = onProgress
      ? (payload: ProgressEvent) => {
          if (payload.type !== 'progress') return;
          progress[payload.index] = {
            processed: payload.processed,
            total: payload.total,
          };
          let processed = 0;
          let total = 0;
          for (const entry of progress) {
            processed += entry.processed;
            total += entry.total;
          }
          onProgress(processed, total);
        }
      : undefined;

    const partials = await Promise.all(
      Array.from({ length: size }, (_unused, index) => {
        const task: PartitionTask = {
          workerModule: WORKER_MODULE,
          dbPath: this.#dbPath,
          config: this.#config,
          query,
          format,
          limit: Number.MAX_SAFE_INTEGER,
          timeoutMs,
          partition: { count: size, index },
        };
        return workerPool.exec(runPartition, [task], { on: reportProgress });
      }),
    );

    const merged: SearchResult[] = [];
    let total = 0;
    let screened = 0;
    let partial = false;
    for (const result of partials) {
      merged.push(...result.results);
      total += result.total;
      screened += result.screened;
      partial = partial || result.partial;
    }

    const sorted = sortByMw
      ? merged.toSorted(
          (a, b) =>
            Math.abs((a.mw ?? 0) - queryMw) - Math.abs((b.mw ?? 0) - queryMw),
        )
      : merged;

    return {
      results: sorted.slice(from, from + limit),
      total,
      screened,
      partial,
    };
  }

  /** Terminate every worker. Safe to call when none were spawned. */
  async close(): Promise<void> {
    const workerPool = this.#pool;
    this.#pool = undefined;
    if (workerPool) await workerPool.terminate();
  }

  #ensurePool(): Pool {
    this.#pool ??= pool({
      maxWorkers: this.#size,
      workerThreadOpts: { execArgv: WORKER_EXEC_ARGV },
    });
    return this.#pool;
  }
}
