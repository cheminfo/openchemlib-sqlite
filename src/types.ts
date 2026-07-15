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

export type SearchMode =
  | 'substructure'
  | 'exact'
  | 'exactNoStereo'
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
   * Column containing the stereo-stripped OCL idCode.
   * Required to use the 'exactNoStereo' search mode.
   * @default null
   */
  idCodeNoStereoColumn?: string | null;
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
   * Number of worker threads used for parallel substructure search. When the
   * database is file-backed (so the path can be derived from the connection),
   * the scan's candidates are partitioned across this many worker threads, each
   * opening its own connection, so a large scan never blocks the calling thread
   * and is split across CPU cores. For an in-memory database — which a worker
   * cannot share — the scan always runs synchronously on the calling thread
   * regardless of this value (and stays browser-compatible).
   *
   * Defaults to the machine's core count, since a scan is CPU-bound (parsing
   * and matching each candidate) and idle cores are wasted wall-clock time.
   * @default availableParallelism()
   */
  poolSize?: number;
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
   * Restrict the substructure scan to entries whose molecular weight is in the
   * half-open range `[lo, hi)`. Used internally to partition a parallel search
   * across worker threads by mw band (sargable on the mw-clustered ocl_ss_index
   * primary key), so each worker scans only its slice of the rows in
   * ascending-mw order; callers normally omit it.
   */
  partition?: { lo: number; hi: number };
  /**
   * Restrict the search to the entries returned by a subquery, so the scan only
   * considers rows the caller already knows are relevant.
   *
   * A scan's cost is dominated by parsing and matching each candidate molecule,
   * so narrowing the candidate set is by far the most effective way to speed one
   * up: on a 45 k-molecule database, restricting a substructure scan from every
   * row to the 6 k matching an attribute filter takes it from ~1470 ms to
   * ~210 ms, and the gap widens with the table size. Prefer this over filtering
   * the results afterwards, which pays for the full scan first.
   *
   * The subquery is inlined into the scan and streamed — nothing is
   * materialised, so a candidate set of any size costs no extra memory — and it
   * composes with `partition`, each worker applying the same subquery within its
   * own mw band.
   *
   * `sql` must select exactly one column, named `entry_id`, holding primary keys
   * of the entries table. Bound values go in `params` and must be **named**
   * parameters (`:name`), because the scan binds its own anonymous ones.
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
