export interface StatementResult {
  lastInsertRowid: number | bigint;
  changes: number | bigint;
}

/** Duck-typed SQLite statement — compatible with node:sqlite StatementSync and better-sqlite3 Statement. */
export interface SQLiteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
  run(...params: unknown[]): StatementResult;
  /** Stream rows lazily so a scan can stop early (node:sqlite + better-sqlite3). */
  iterate?(...params: unknown[]): IterableIterator<unknown>;
  /** node:sqlite: call before all()/get() to return INTEGER columns as BigInt. */
  setReadBigInts?(flag: boolean): void;
}

/** Duck-typed SQLite database handle — compatible with node:sqlite DatabaseSync and better-sqlite3 Database. */
export interface SQLiteDatabase {
  prepare(sql: string): SQLiteStatement;
  exec(sql: string): void;
}

/** One step of a schema migration, reported to {@link MigrateOptions.onMigration}. */
export interface MigrationEvent {
  /** Schema version being applied. */
  version: number;
  /** What this version changes. */
  description: string;
  /** `start` and `done` bracket a version; `progress` repeats in between. */
  phase: 'start' | 'progress' | 'done';
  /** Rows rewritten so far (`progress` only). */
  done?: number;
  /** Rows to rewrite in total (`progress` only). */
  total?: number;
  /** How long the version took, in ms (`done` only). */
  elapsedMs?: number;
  /**
   * Rows the migration discarded as unusable (`done` only, omitted when none).
   * Only orphaned fingerprints — ones whose entry no longer exists, which no
   * search could ever return — are ever dropped.
   */
  dropped?: number;
}

/** Options for the `migrate()` method of `MoleculesDBSQLite`. */
export interface MigrateOptions {
  /**
   * Called as migrations run. Upgrading a large index rewrites every row, which
   * can take seconds, so wire this to your logger — otherwise a startup that is
   * working looks exactly like one that has hung.
   */
  onMigration?: (event: MigrationEvent) => void;
}

export type SearchMode =
  | 'substructure'
  | 'exact'
  | 'exactNoStereo'
  | 'exactNoStereoTautomer'
  | 'similarity';
export type InputFormat = 'smiles' | 'idCode' | 'molfile';

/** Configuration describing the existing entries table that ocl_ss_index references. */
export interface MoleculesDBConfig {
  /** Name of the existing molecules/entries table. */
  entriesTable: string;
  /**
   * Primary key column of the entries table.
   * @default 'id'
   */
  pkColumn?: string;
  /**
   * Column containing the OCL idCode.
   * @default 'id_code'
   */
  idCodeColumn?: string;
  /**
   * Column on the entries table holding each molecule's weight (REAL). The
   * ocl_ss_index is clustered by molecular weight, so this column is read once
   * per entry at `insert()` to populate the index's own `mw`; when it is null,
   * `insert()` instead derives the weight from the molecule. Either way the
   * index is mw-ordered, so substructure results are always ordered by ascending
   * |queryMw − resultMw| and each carries a `mw` field.
   * @default null
   */
  mwColumn?: string | null;
  /**
   * Number of verifier threads used for substructure search.
   *
   * A substructure search is two steps: a fingerprint prescreen in SQL (~3% of
   * the cost) and then parsing and graph-matching each surviving candidate
   * (~97%). The prescreen runs once, on the calling thread's connection; only
   * the verification is spread over this many threads, as batches of idCodes.
   * The verifiers hold no database connection, so this works for any database —
   * in-memory and file-backed alike.
   *
   * Defaults to the machine's core count, since verification is CPU-bound and
   * idle cores are wasted wall-clock time. Set to 1 to keep everything on the
   * calling thread (no worker is ever spawned).
   * @default availableParallelism()
   */
  poolSize?: number;
  /**
   * Number of candidates handed to a verifier thread per batch.
   *
   * Batches are dispatched to whichever thread is free, so the work self-balances
   * regardless of how candidates are distributed; smaller batches balance better
   * but pay more round trips. A scan that never fills a single batch is verified
   * inline, without spawning any thread.
   * @default 128
   */
  batchSize?: number;
  /**
   * Number of recent structure searches (substructure / similarity) whose full
   * result set is kept in an in-memory LRU cache, keyed by the query. A repeated
   * search for the same structure — e.g. paging through results — then returns
   * instantly instead of re-running the scan. The cache is cleared whenever
   * `insert()` changes the data. Set to 0 to disable caching.
   * @default 100
   */
  searchCacheSize?: number;
}

export interface SearchOptions {
  /**
   * @default 'exact'
   */
  mode?: SearchMode;
  /**
   * @default 'smiles'
   */
  format?: InputFormat;
  /**
   * Minimum Tanimoto coefficient for similarity search.
   * @default 0.5
   */
  similarityThreshold?: number;
  /**
   * Maximum number of results to return.
   * @default Number.MAX_SAFE_INTEGER
   */
  limit?: number;
  /**
   * Result offset for pagination.
   * @default 0
   */
  from?: number;
  /**
   * Timeout in ms for scan-based searches (substructure / similarity).
   * @default 5000
   */
  timeoutMs?: number;
  /**
   * Maximum number of fingerprint candidates to load from the database before stopping.
   * Limits memory usage and scan time when the fingerprint prefilter matches many rows.
   * When hit, the search returns partial results with `partial: true`.
   * @default Number.MAX_SAFE_INTEGER
   */
  maxCandidates?: number;
  /**
   * Maximum number of confirmed substructure matches to collect before stopping.
   * Once this many matches are found the scan stops, sorts them by MW proximity
   * (when mwColumn is configured), and returns them with `partial: true`.
   * @default Number.MAX_SAFE_INTEGER
   */
  maxResults?: number;
  /**
   * Progress callback for the substructure scan, invoked periodically (and once
   * at the end) with the number of screened candidates processed so far and the
   * total to process. Lets a caller report progress or drive a progress bar
   * while a large scan runs — e.g. from inside a worker thread.
   */
  onProgress?: (processed: number, total: number) => void;
  /**
   * Restrict the search to the entries returned by a subquery, so the scan only
   * considers rows the caller already knows are relevant.
   *
   * A scan's cost is dominated by parsing and matching each candidate molecule,
   * so narrowing the candidate set is by far the most effective way to speed one
   * up. Prefer this over filtering the results afterwards, which pays for the
   * full scan first.
   *
   * The subquery becomes a membership test on the single prescreen, so it is
   * executed exactly once per search however many verifier threads are running.
   *
   * `sql` must select exactly one column, named `entry_id`, holding primary keys
   * of the entries table. Bound values go in `params` and must be **named**
   * parameters (`:name`), because the prescreen binds its own anonymous ones.
   * @example
   * ```js
   * // only search ligands whose name contains "acetate"
   * await moleculesDB.search(query, {
   *   mode: 'substructure',
   *   candidates: {
   *     sql: 'SELECT id AS entry_id FROM ligands WHERE name LIKE :name',
   *     params: { name: '%acetate%' },
   *   },
   * });
   * ```
   */
  candidates?: SearchCandidates;
}

/** A subquery restricting a search to a subset of the entries table. */
export interface SearchCandidates {
  /** A SELECT returning exactly one column, named `entry_id`. */
  sql: string;
  /** Named parameters (`:name`) bound to {@link SearchCandidates.sql}. */
  params?: Record<string, unknown>;
}

export interface SearchResult {
  /** Primary key of the matching entry in the entries table. */
  entryId: number;
  idCode: string;
  /** Only present for similarity mode. */
  similarity?: number;
  /** Molecular weight (from the mw-clustered index). Present in 'substructure' mode. */
  mw?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Total matching results before applying limit/from. */
  total: number;
  /** True when the scan was cut short by the timeout. */
  partial?: boolean;
  /** Number of candidate rows screened (substructure mode only). */
  screened?: number;
  /** Number of confirmed substructure matches found (substructure mode only). */
  matched?: number;
  /** Wall-clock time spent in the scan, in ms (substructure mode only). */
  elapsedMs?: number;
}

/** Which of the two structure hashes a backfill pass computes. */
export type HashKind = 'noStereo' | 'noStereoTautomer';

/** What one pass of the backfill did. */
export interface BackfillPassResult {
  /** Which hash this pass computed. */
  kind: HashKind;
  /** Entries that got a hash. */
  hashed: number;
  /** Entries OpenChemLib produced no hash for, within the cap. */
  noHash: number;
  /** Entries the cap stopped, stored as NULL. */
  timedOut: number;
  /** Entries still owed this hash when the pass returned. */
  remaining: number;
  /** Wall-clock time of the pass, in ms. */
  elapsedMs: number;
}

/** What a whole backfill run did, across both passes. */
export interface BackfillResult {
  /** One entry per pass, in the order they ran: no-stereo, then tautomer. */
  passes: BackfillPassResult[];
  /** Entries that got a hash, summed over both passes. */
  hashed: number;
  /** Entries with no hash, summed over both passes. */
  noHash: number;
  /** Entries the cap stopped, summed over both passes. */
  timedOut: number;
  /** Hashes still owed when the run returned, summed over both passes. */
  remaining: number;
  /** Wall-clock time of the whole run, in ms. */
  elapsedMs: number;
}

/** A progress report: one pass's running totals plus its position. */
export interface BackfillProgress extends BackfillPassResult {
  /** Entries this pass has processed so far. */
  done: number;
  /** Entries this pass found to do when it started. */
  total: number;
}

/** Options for `backfillHashes()`. */
export interface BackfillOptions {
  /**
   * Number of worker threads hashing molecules.
   *
   * Hashing is CPU-bound and holds no database connection, so this is the whole
   * of the run's parallelism; the writes stay on the calling thread.
   * @default availableParallelism()
   */
  poolSize?: number;
  /**
   * How long one molecule may take before it is given up on and stored as NULL.
   *
   * It exists for the tautomer hash, whose cost per molecule spans four orders
   * of magnitude: the median is ~123 µs but a molecule with many tautomeric
   * sites can run for seconds, and those few dominate the total. Canonization is
   * synchronous inside WebAssembly and cannot be cancelled, so the cap is
   * enforced by destroying the worker and starting a fresh one (~50 ms), which
   * is why a very small cap costs more than it saves. The no-stereo pass is
   * nowhere near it — its p99 is ~359 µs — so the cap never fires there.
   *
   * Measured over a 400k-molecule corpus: 100 ms gives up on ~2% of molecules
   * and takes ~3 min on 8 cores, against 2.4 h with no cap at all.
   * @default 100
   */
  capMs?: number;
  /**
   * Entries hashed between commits.
   *
   * Each chunk is one short transaction, so a run never holds the write lock
   * while molecules are being canonized, and an interruption loses at most one
   * chunk of work.
   * @default 500
   */
  chunkSize?: number;
  /**
   * Stop each pass after this many entries, leaving the rest for a later run.
   * Lets a caller spend a bounded amount of time per pass and resume later; a
   * run is resumable at chunk granularity either way.
   * @default Number.MAX_SAFE_INTEGER
   */
  limit?: number;
  /**
   * Called after each committed chunk, with the running pass's totals. A full
   * backfill is minutes to hours, so wire this to your logger — a run that is
   * working should not look like one that has hung.
   */
  onProgress?: (progress: BackfillProgress) => void;
  /**
   * Stops the run at the next chunk boundary. Everything committed stays
   * committed and the next run resumes from there.
   */
  signal?: AbortSignal;
}
