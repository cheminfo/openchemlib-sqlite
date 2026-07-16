import { availableParallelism } from 'node:os';

import type { Pool } from 'workerpool';
import { pool } from 'workerpool';

import type { VerifyResult, VerifyTask } from './searchWorker.ts';

/** Options to create a {@link SearchWorkerPool}. */
export interface SearchWorkerPoolOptions {
  /**
   * Number of verifier threads (clamped to >= 1).
   * @default availableParallelism()
   */
  poolSize?: number;
}

/** The subset of the worker module the offloaded bootstrap calls. */
interface SearchWorkerModule {
  verifyBatch: (task: VerifyTask) => VerifyResult;
}

// Where each worker re-imports the verifier from. From the published package
// (this module is `.js` inside node_modules) a bare subpath specifier keeps the
// worker self-contained and survives bundling; from source (`.ts`) we point at
// the sibling file and strip types in the worker thread. Either way the worker
// code ships inside the package — there is no loose file to discover.
const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_MODULE = FROM_SOURCE
  ? new URL('searchWorker.ts', import.meta.url).href
  : 'openchemlib-sqlite/worker';
const WORKER_EXEC_ARGV = FROM_SOURCE ? ['--experimental-strip-types'] : [];

// Offloaded to each workerpool worker. It is stringified and re-evaluated in the
// worker, so it must be fully self-contained: it only reads `task` and imports
// the worker module by the specifier the pool chose.
function runVerify(task: VerifyTask): Promise<VerifyResult> {
  // Build the dynamic import through `new Function` so bundlers (Vite, esbuild,
  // …) cannot see or rewrite the `import()` — this function is stringified and
  // re-evaluated in a bare worker where only the native `import()` exists.
  // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval -- intentional: hide import() from bundlers
  const importModule = new Function(
    'specifier',
    'return import(specifier);',
  ) as (specifier: string) => Promise<SearchWorkerModule>;
  return importModule(task.workerModule).then((module) =>
    module.verifyBatch(task),
  );
}

/**
 * Pool of stand-by worker threads that answer "does this fragment occur in this
 * molecule?" for batches of prescreened candidates.
 *
 * The workers hold no database connection and run no query: the caller
 * prescreens once and feeds them idCodes. Batches are handed to whichever worker
 * is free, so the work self-balances no matter how the candidates are
 * distributed — and because the workers are stateless, concurrent searches share
 * the same pool instead of each monopolising it.
 */
export class SearchWorkerPool {
  readonly #size: number;
  #pool: Pool | undefined;

  /**
   * Create a pool (workers are spawned lazily, on the first batch).
   * @param options - The worker count.
   */
  constructor(options: SearchWorkerPoolOptions = {}) {
    this.#size = Math.max(
      1,
      Math.trunc(options.poolSize ?? availableParallelism()),
    );
  }

  /**
   * Number of verifier threads this pool may run.
   * @returns The resolved worker count.
   */
  get size(): number {
    return this.#size;
  }

  /**
   * Verify one batch of candidates against a fragment.
   * @param fragment - The query fragment as an OCL idCode.
   * @param idCodes - Candidate idCodes to test.
   * @returns The positions within `idCodes` that contain the fragment.
   */
  async verify(fragment: string, idCodes: string[]): Promise<number[]> {
    const task: VerifyTask = { workerModule: WORKER_MODULE, fragment, idCodes };
    const result = await this.#ensurePool().exec(runVerify, [task]);
    return result.matches;
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
