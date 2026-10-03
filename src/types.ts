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
  /**
   * Register a SQL function (node:sqlite + better-sqlite3). A scan uses one to
   * stop at its deadline from inside SQLite; without it, the deadline is only
   * checked between the rows a scan yields.
   */
  function?(
    name: string,
    options: { deterministic?: boolean; varargs?: boolean },
    fn: (...args: unknown[]) => number,
  ): unknown;
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
   * The ceiling on how many tautomers OpenChemLib enumerates for one molecule
   * before it settles for what it has. A molecule that reaches it gets no
   * tautomer hash, stored as NULL, exactly like one OpenChemLib cannot read.
   *
   * It is a work bound rather than a clock, so the same molecule gets the same
   * answer on every machine and a database holds the same hashes wherever it was
   * filled. The default gives up on about 2.6% of a drug-like corpus; the old
   * 100 ms clock gave up on about 2.3%, but on a loaded machine it also gave up
   * on molecules a quiet one hashed.
   *
   * Which molecules have a tautomer hash depends on this, so it is recorded in
   * the database: changing it makes the next `migrate()` empty the tautomer hash
   * table, and `backfillHashes()` fills it again under the new ceiling.
   * @default 5000
   */
  maxTautomers?: number;
  /**
   * Whether {@link MoleculesDBConfig.mwColumn} really holds molecular weights.
   *
   * A substructure match cannot be lighter than its fragment, and the index is
   * clustered by weight, so the prescreen can start with a seek past every entry
   * too light to match instead of reading them. That is only sound if the stored
   * weight is the molecular weight: a column holding a sort key, a rounded
   * value or a different convention would make the bound drop real matches, so
   * with a `mwColumn` configured the library does not assume it. Set this when
   * the column is the molecular weight and you want the bound.
   *
   * Ignored without a `mwColumn`, where `insert()` derives the weight itself and
   * the bound always applies.
   * @default false
   */
  trustMwColumn?: boolean;
  /**
   * The share of the index above which a substructure search stays on the
   * column scan rather than using the plane index.
   *
   * Verification costs ~8 µs a candidate against ~0.25 µs a row for the
   * clustered scan, so the two break even once candidates reach about 1.4% of
   * the index. Below that the screen was the query's whole cost; above it,
   * verification swamps whatever the screen saves. Raise it only with a
   * measurement.
   * @default 0.01
   */
  planeCandidateRatio?: number;
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
   *
   * The round trip is most of the cost at a small size: measured over real
   * idCodes, one candidate costs 32.0 µs at 64, 10.7 µs at 256 and 8.2 µs at
   * 1024. Verification is the bulk of a substructure search, so the default is
   * the large one; a search bounded by `maxResults` shrinks it again by itself,
   * to about one round per thread, so nothing is overshot by raising it.
   * @default 1024
   */
  batchSize?: number;
  /**
   * Number of recent structure searches (substructure / similarity) whose full
   * result set is kept in an in-memory LRU cache, keyed by the query. A repeated
   * search for the same structure — e.g. paging through results — then returns
   * instantly instead of re-running the scan. The cache is cleared whenever
   * `insert()` changes the data. A scan that ran out of time is never kept, so
   * a retry gets the chance to answer in full. Set to 0 to disable caching.
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
   *
   * On a driver with {@link SQLiteDatabase.function} the deadline is also read
   * from inside the scan's statement, so a scan that yields no row still stops
   * on time; {@link SearchResponse.timedOut} then says the clock stopped it.
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
   * How the subquery is applied is its {@link SearchCandidates.strategy}; every
   * strategy runs on the single prescreen, so however many verifier threads are
   * running, it is evaluated once per search.
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
  /**
   * Bounds on the weight the index is clustered by, both inclusive.
   *
   * `ocl_ss_index` is stored in ascending weight order, so a bound here is a seek
   * on its key rather than a test on each row: the scan starts at `min` and ends
   * at `max` without reading anything outside them. Expressed in `candidates`
   * instead, the same bound would be checked entry by entry — or, as a
   * membership list, would list every entry in range before the first candidate
   * is read.
   *
   * The values are compared with the weight the index stores: the one `insert()`
   * derived, or the `mwColumn` or precomputed `mw` the caller supplied. Every mode
   * honours it.
   * @default {} — unbounded
   */
  mwRange?: MwRange;
  /**
   * Resume a substructure scan after this position, as a previous search's
   * {@link SearchResponse.resume} gave it.
   *
   * Candidates stream in `(mw, entry_id)` order, the order the index is
   * clustered in, so the scan seeks past the position on that key and reads
   * nothing before it: a deep page costs what the first one does. Ignored by
   * the other modes.
   * @default undefined — from the first candidate
   */
  after?: ScanPosition;
}

/**
 * Where a substructure scan stands: the weight and entry id of a candidate,
 * the key the index is clustered by.
 */
export interface ScanPosition {
  /** The candidate's weight, as the index stores it. */
  mw: number;
  /** The candidate's entry id. */
  entryId: number;
}

/** Inclusive bounds on the weight the index is clustered by. */
export interface MwRange {
  /**
   * The lightest weight kept.
   * @default undefined — no lower bound
   */
  min?: number;
  /**
   * The heaviest weight kept.
   * @default undefined — no upper bound
   */
  max?: number;
}

/**
 * How a candidates subquery restricts a scan.
 *
 * - `membership` — the subquery runs once, its ids are held in memory, and the
 *   scan tests each entry against them. It is the right choice for a modest
 *   subquery an index answers, and it is what a caller gets by default.
 * - `probe` — the subquery never runs as a whole: each entry the fingerprint
 *   prescreen lets through is looked up in it, as a correlated `EXISTS`. Right
 *   when the subquery keeps a large share of the entries or tests a column no
 *   index covers, because listing such a subquery first reads most of the table
 *   before the scan yields anything. The scan streams lightest-first and stops
 *   as soon as it has enough, so its cost follows the page, not the subquery.
 *   The subquery should be a plain SELECT — joins and WHERE — so SQLite can push
 *   the entry id into it.
 * - `drive` — the subquery is the outer loop: each entry it returns has its
 *   fingerprint read through the `entry_id` index, and the survivors are sorted
 *   by weight. Right when the subquery returns few rows: its cost is then the
 *   subquery's own however large the index is, where the other two would scan
 *   the index until they had read past every candidate.
 */
export type CandidateStrategy = 'membership' | 'probe' | 'drive';

/** A subquery restricting a search to a subset of the entries table. */
export interface SearchCandidates {
  /** A SELECT returning exactly one column, named `entry_id`. */
  sql: string;
  /** Named parameters (`:name`) bound to {@link SearchCandidates.sql}. */
  params?: Record<string, unknown>;
  /**
   * How the subquery restricts the scan; see {@link CandidateStrategy}.
   * @default 'membership'
   */
  strategy?: CandidateStrategy;
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
  /**
   * True when the scan stopped because its time ran out, rather than at
   * `maxResults` or at the end of the candidates.
   */
  timedOut?: boolean;
  /**
   * Substructure only: where a scan that stopped before reading every
   * candidate resumes — pass it as {@link SearchOptions.after} — and undefined
   * once it has read them all. It is the last match kept when the scan stopped
   * at `maxResults`, and the last candidate read when it ran out of time.
   *
   * Also undefined when the plane index answered a scan that stopped early: it
   * reads in slot order, so there is no position to resume from, and `partial`
   * is what says the answer is incomplete.
   */
  resume?: ScanPosition;
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
   * The ceiling on tautomer enumeration for this run, overriding the instance's
   * {@link MoleculesDBConfig.maxTautomers}.
   *
   * Overriding it here fills the table under a ceiling the database does not
   * record, so the hashes stop matching what `search()` computes for its query.
   * It exists for measuring the trade-off, not for production runs.
   */
  maxTautomers?: number;
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

/**
 * What a caller has already computed for an entry, so the library does not
 * compute it a second time.
 *
 * Every field is independent: what is given is stored, what is absent is derived
 * from the molecule exactly as before, so an existing `insert()` call keeps its
 * behaviour.
 *
 * It exists because the caller is often a database that already holds these
 * values. Measured over real idcodes, building the fingerprint is 1350 µs an
 * entry and writing one already in hand is 88 µs — at 150 million entries, 56
 * hours against under four.
 */
export interface PrecomputedEntry {
  /**
   * The 512-bit FragFp, as `getIndex()` from openchemlib-search-wasm or
   * `Molecule.getIndex()` returns it, or as the eight 64-bit words already
   * packed.
   *
   * Building it is ~99% of what indexing an entry costs, so this is the field
   * worth passing.
   */
  index?: Int32Array | Uint32Array | number[] | BigInt64Array | bigint[];
  /**
   * The molecular weight the index is clustered by.
   *
   * Without it the weight is read from {@link MoleculesDBConfig.mwColumn}, or
   * derived from the molecule when no such column is configured. With a
   * `mwColumn` configured this must be the value that column holds, or the
   * index's clustered order stops matching what a bulk path would have written.
   */
  mw?: number;
}
