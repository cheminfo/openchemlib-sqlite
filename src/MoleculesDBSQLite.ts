import { availableParallelism } from 'node:os';

import { LRUCache } from 'lru-cache';
import type * as OpenChemLib from 'openchemlib';
import { getIndex, substructureSearch } from 'openchemlib-search-wasm';

import type { SearchWorkerPool } from './SearchWorkerPool.ts';
import { runMigrations } from './migrations.ts';
// Type-only: erased at build, so node:worker_threads is never pulled into the
// synchronous/browser path. The pool is loaded lazily via dynamic import.
import type {
  MigrateOptions,
  MoleculesDBConfig,
  SQLiteDatabase,
  SearchCandidates,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from './types.ts';
import { packSSIndex, unpackSSIndex } from './utils/packSSIndex.ts';
import type { PrescreenState } from './utils/prescreen.ts';
import { prescreen } from './utils/prescreen.ts';
import { runSubstructureSearch } from './utils/runSubstructureSearch.ts';
import { parseMolecule, rowToResult } from './utils/searchHelpers.ts';

type OCLLibrary = typeof OpenChemLib;
type OCLMolecule = InstanceType<OCLLibrary['Molecule']>;

interface ResolvedConfig {
  entriesTable: string;
  pkColumn: string;
  idCodeColumn: string;
  idCodeNoStereoColumn: string | null;
  mwColumn: string | null;
  poolSize: number;
  batchSize: number;
  searchCacheSize: number;
}

function resolveConfig(config: MoleculesDBConfig): ResolvedConfig {
  return {
    entriesTable: config.entriesTable,
    pkColumn: config.pkColumn ?? 'id',
    idCodeColumn: config.idCodeColumn ?? 'id_code',
    idCodeNoStereoColumn: config.idCodeNoStereoColumn ?? null,
    mwColumn: config.mwColumn ?? null,
    poolSize: config.poolSize ?? availableParallelism(),
    batchSize: config.batchSize ?? 128,
    searchCacheSize: config.searchCacheSize ?? 100,
  };
}

/** A cached full (unsliced) structure-scan result, paginated on each hit. */
interface CachedScan {
  results: SearchResult[];
  screened: number;
  matched: number;
  partial: boolean;
  elapsedMs: number;
}

/**
 * Return mol with its fragment flag set to the requested value.
 * When fromInstance is true (caller passed a Molecule object), a compact copy
 * is created only if the flag would change — never mutates the original.
 * When fromInstance is false (molecule was freshly created from a string), mol
 * is mutated in place and returned.
 * @param mol - The molecule to adjust.
 * @param fragment - Desired fragment flag value.
 * @param fromInstance - True when mol was provided by the caller (must not mutate).
 * @returns mol or a compact copy with the correct fragment flag.
 */
function withFragment(
  mol: OCLMolecule,
  fragment: boolean,
  fromInstance: boolean,
): OCLMolecule {
  if (fromInstance) {
    if (mol.isFragment() === fragment) return mol;
    const copy = mol.getCompactCopy();
    copy.setFragment(fragment);
    return copy;
  }
  mol.setFragment(fragment);
  return mol;
}

/**
 * Identify a candidates subquery inside a search-cache key, so a restricted
 * search never returns another subset's — or the unrestricted — cached results.
 * @param candidates - The subquery restricting the search, if any.
 * @returns A key fragment identifying the subquery and its bound values.
 */
function candidatesKey(candidates: SearchCandidates | undefined): string {
  if (!candidates) return '';
  return `${candidates.sql}|${JSON.stringify(candidates.params ?? {})}`;
}

export class MoleculesDBSQLite {
  #db: SQLiteDatabase;
  #ocl: OCLLibrary;
  #cfg: ResolvedConfig;
  #ssIndexCols: string;
  #ssJoin: string;
  #selectCols: string;
  #pool: SearchWorkerPool | undefined;
  #searchCache: LRUCache<string, CachedScan> | undefined;

  constructor(db: SQLiteDatabase, ocl: OCLLibrary, config: MoleculesDBConfig) {
    this.#db = db;
    this.#ocl = ocl;
    this.#cfg = resolveConfig(config);
    this.#searchCache =
      this.#cfg.searchCacheSize > 0
        ? new LRUCache<string, CachedScan>({ max: this.#cfg.searchCacheSize })
        : undefined;

    const { pkColumn, idCodeColumn } = this.#cfg;
    this.#ssIndexCols =
      's.ss_index0, s.ss_index1, s.ss_index2, s.ss_index3, s.ss_index4, s.ss_index5, s.ss_index6, s.ss_index7';
    this.#ssJoin = `JOIN ocl_ss_index s ON s.entry_id = e.${pkColumn}`;
    this.#selectCols = `e.${pkColumn} AS entry_id, e.${idCodeColumn} AS id_code`;
  }

  /**
   * Bring the database's schema up to date, creating it if absent.
   *
   * Idempotent, and safe to call on every startup: it records the schema version
   * it reaches, applies only what is missing, and does nothing once current. A
   * database written by an older release is upgraded in place — an index built
   * before the mw clustering, for instance, is rewritten rather than rejected,
   * carrying its fingerprints over instead of recomputing them.
   *
   * Call it before searching. A stale schema is not silently tolerated: the
   * queries reference columns an old index does not have.
   * @param options - Optional log callback; see {@link MigrateOptions}.
   * @returns The schema versions applied, in order (empty when already current).
   */
  migrate(options: MigrateOptions = {}): number[] {
    const { entriesTable, pkColumn, idCodeColumn, mwColumn } = this.#cfg;
    const applied = runMigrations({
      db: this.#db,
      ocl: this.#ocl,
      entriesTable,
      pkColumn,
      idCodeColumn,
      mwColumn,
      onMigration: options.onMigration,
    });
    // A rewritten index invalidates anything cached from the old one.
    if (applied.length > 0) this.#searchCache?.clear();
    return applied;
  }

  /**
   * Total number of indexed entries.
   * @returns Entry count.
   */
  count(): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM ocl_ss_index')
      .get() as { n: number };
    return row.n;
  }

  /**
   * Store the OCL SS fingerprint for an entry that already exists in the
   * entries table.
   * @param entryId - Primary key of the entry in the entries table.
   * @param molecule - OCL Molecule instance or idCode string.
   */
  insert(entryId: number, molecule: string | OCLMolecule): void {
    const { mwColumn, entriesTable, pkColumn } = this.#cfg;
    // Building the fingerprint is ~99% of what indexing an entry costs, so from an idCode it is
    // built by openchemlib-search-wasm (~920 µs) rather than openchemlib-js (~4491 µs). The words
    // are the same, bit for bit, and a BigInt64Array over them is already the eight columns below.
    // A Molecule the caller passed in cannot take that path without being re-encoded, so it keeps
    // its own fingerprint.
    const packed =
      typeof molecule === 'string'
        ? Array.from(new BigInt64Array(getIndex(molecule).buffer, 0, 8))
        : packSSIndex(molecule.getIndex());

    if (mwColumn) {
      // Take mw from the entries table so the clustered order matches whatever
      // a bulk index path stores; the entry already exists there.
      this.#db
        .prepare(
          `INSERT OR REPLACE INTO ocl_ss_index (mw, entry_id, ss_index0, ss_index1, ss_index2, ss_index3, ss_index4, ss_index5, ss_index6, ss_index7) VALUES ((SELECT COALESCE(${mwColumn}, 0) FROM ${entriesTable} WHERE ${pkColumn} = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(entryId, entryId, ...packed);
    } else {
      // Only this branch needs the molecule itself. `false` skips 2D-coordinate invention: the
      // molecular weight never reads a coordinate, and inventing them is ~20x the cost of the parse.
      const mol =
        typeof molecule === 'string'
          ? this.#ocl.Molecule.fromIDCode(molecule, false)
          : molecule;
      let mw = 0;
      try {
        mw = mol.getMolecularFormula().relativeWeight;
      } catch {
        // a molecule with no computable formula sorts first (mw = 0)
      }
      this.#db
        .prepare(
          'INSERT OR REPLACE INTO ocl_ss_index (mw, entry_id, ss_index0, ss_index1, ss_index2, ss_index3, ss_index4, ss_index5, ss_index6, ss_index7) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(mw, entryId, ...packed);
    }
    // The data changed, so cached search results are stale.
    this.#searchCache?.clear();
  }

  /** Clear the in-memory structure-search result cache. */
  clearSearchCache(): void {
    this.#searchCache?.clear();
  }

  /**
   * Search the database for molecules matching a query.
   *
   * Substructure search prescreens once on this connection and spreads the
   * verification over `poolSize` threads (see {@link MoleculesDBConfig}), so a
   * large scan is split across cores and the calling thread is only ever busy
   * for one batch at a time.
   *
   * **A substructure query is matched as its idCode**, on every path and at every
   * `poolSize`, so one query always gives one answer. `getIDCode` does not carry
   * every molfile bond query feature: a bond drawn "double or aromatic" comes back
   * delocalized, and such a query then matches a narrower set than the `Molecule`
   * itself would. SMILES and idCode queries are unaffected.
   * @param query - Query molecule as an OCL Molecule instance or as a string
   *   parsed according to options.format (ignored when a Molecule is passed).
   * @param options - Search options.
   * @returns Search response containing results and metadata.
   */
  async search(
    query: string | OCLMolecule,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    const {
      mode = 'exact',
      format = 'smiles',
      similarityThreshold = 0.5,
      limit = Number.MAX_SAFE_INTEGER,
      from = 0,
      timeoutMs = 5000,
      maxCandidates = Number.MAX_SAFE_INTEGER,
      maxResults = Number.MAX_SAFE_INTEGER,
      onProgress,
      candidates,
    } = options ?? {};

    const { entriesTable, idCodeColumn, idCodeNoStereoColumn, pkColumn } =
      this.#cfg;
    const { Molecule } = this.#ocl;

    // Restricting the entries table to the candidate subquery. Every mode
    // honours it, so a caller can never get unfiltered results by picking one.
    const candidateJoin = candidates
      ? `JOIN (${candidates.sql}) c ON c.entry_id = e.${pkColumn}`
      : '';
    const candidateParams = candidates?.params ? [candidates.params] : [];

    const fromInstance = typeof query !== 'string';
    // Parsing is deferred to each mode: only the modes that re-encode the query
    // to a canonical idCode need 2D coordinates invented, and `exact` on an
    // idCode does not even need to parse (see below).
    const parse = (ensureCoordinates: boolean): OCLMolecule =>
      typeof query === 'string'
        ? parseMolecule(Molecule, query, format, ensureCoordinates)
        : query;

    switch (mode) {
      case 'exact': {
        // An idCode IS the canonical encoding stored in this column, so match it
        // as a plain string. Parsing and re-encoding it would invent coordinates
        // for nothing — and is not even lossless: the round trip changes the
        // idCode for a small number of molecules, which then silently go missing.
        const idCode =
          typeof query === 'string' && format === 'idCode'
            ? query
            : withFragment(parse(true), false, fromInstance).getIDCode();
        const rows = this.#db
          .prepare(
            `SELECT ${this.#selectCols} FROM ${entriesTable} e ${this.#ssJoin} ${candidateJoin} WHERE e.${idCodeColumn} = ?`,
          )
          .all(...candidateParams, idCode) as Array<Record<string, unknown>>;
        return {
          results: rows.slice(from, from + limit).map(rowToResult),
          total: rows.length,
        };
      }

      case 'exactNoStereo': {
        if (!idCodeNoStereoColumn) {
          throw new Error(
            'exactNoStereo search requires idCodeNoStereoColumn to be configured',
          );
        }
        // This mode re-encodes the query with getIDCode(), so it needs
        // coordinates: without them OCL drops the stereo descriptors and the
        // re-encoded idCode no longer matches what was stored.
        const baseMol = parse(true);
        // stripStereoInformation always mutates, so always copy if fromInstance
        const mol = fromInstance ? baseMol.getCompactCopy() : baseMol;
        mol.setFragment(false);
        mol.stripStereoInformation();
        const idCodeNoStereo = mol.getIDCode();
        const rows = this.#db
          .prepare(
            `SELECT ${this.#selectCols} FROM ${entriesTable} e ${this.#ssJoin} ${candidateJoin} WHERE e.${idCodeNoStereoColumn} = ?`,
          )
          .all(...candidateParams, idCodeNoStereo) as Array<
          Record<string, unknown>
        >;
        return {
          results: rows.slice(from, from + limit).map(rowToResult),
          total: rows.length,
        };
      }

      case 'substructure': {
        // No coordinates: the fingerprint prefilter and the graph match are both
        // coordinate-independent, and inventing them is ~20x the parse.
        const mol = withFragment(parse(false), true, fromInstance);
        const queryIdCode = mol.getIDCode();
        const scan = await this.#cachedScan(
          `sub|${queryIdCode}|${maxResults}|${maxCandidates}|${candidatesKey(candidates)}`,
          () =>
            this.#scanSubstructureFull(
              mol,
              queryIdCode,
              maxResults,
              maxCandidates,
              timeoutMs,
              onProgress,
              candidates,
            ),
        );
        return {
          results: scan.results.slice(from, from + limit),
          total: scan.results.length,
          screened: scan.screened,
          matched: scan.matched,
          partial: scan.partial,
          elapsedMs: scan.elapsedMs,
        };
      }

      case 'similarity': {
        // No coordinates: Tanimoto runs on the fingerprint, which is derived
        // from the graph alone.
        const mol = withFragment(parse(false), false, fromInstance);
        const queryIdCode = mol.getIDCode();
        const scan = await this.#cachedScan(
          `sim|${queryIdCode}|${similarityThreshold}|${candidatesKey(candidates)}`,
          () =>
            Promise.resolve(
              this.#scanSimilarityFull(
                mol,
                similarityThreshold,
                timeoutMs,
                candidates,
              ),
            ),
        );
        return {
          results: scan.results.slice(from, from + limit),
          total: scan.results.length,
          partial: scan.partial,
          elapsedMs: scan.elapsedMs,
        };
      }

      default:
        throw new Error(`Unknown search mode: ${String(mode)}`);
    }
  }

  /**
   * Terminate the substructure worker pool, if one was started. Call on
   * shutdown so the process can exit cleanly. A no-op when no pool exists.
   */
  async close(): Promise<void> {
    await this.#pool?.close();
    this.#pool = undefined;
  }

  // Get the full (unsliced) result set for a structure query from the cache, or
  // compute it via `computeFull` and store it, so subsequent pages are instant.
  async #cachedScan(
    key: string,
    computeFull: () => Promise<CachedScan>,
  ): Promise<CachedScan> {
    const hit = this.#searchCache?.get(key);
    if (hit) return hit;
    const scan = await computeFull();
    this.#searchCache?.set(key, scan);
    return scan;
  }

  // Run a full substructure scan (no pagination).
  //
  // Step 1 (the prescreen) is a single streamed query on this connection — it is
  // only ~3% of the cost, so there is nothing to gain by splitting it, and doing
  // it once means the caller's `candidates` subquery runs once too. Step 2 (parse
  // + graph match, the other ~97%) is handed to the verifier pool in batches, so
  // it self-balances across workers no matter how the candidates are
  // distributed. Candidates stream lightest-first, so stopping at `maxResults`
  // keeps the smallest superstructures.
  //
  // A scan that never fills one batch is verified inline: spawning threads to
  // check a handful of molecules costs more than it saves.
  async #scanSubstructureFull(
    mol: OCLMolecule,
    queryIdCode: string,
    maxResults: number,
    maxCandidates: number,
    timeoutMs: number,
    onProgress: SearchOptions['onProgress'],
    candidates?: SearchCandidates,
  ): Promise<CachedScan> {
    const { entriesTable, pkColumn, idCodeColumn, poolSize, batchSize } =
      this.#cfg;
    const params = {
      db: this.#db,
      ocl: this.#ocl,
      entriesTable,
      pkColumn,
      idCodeColumn,
      mol,
      from: 0,
      limit: Number.MAX_SAFE_INTEGER,
      timeoutMs,
      maxCandidates,
      maxResults,
      onProgress,
      candidates,
    };
    if (poolSize <= 1) {
      const r = runSubstructureSearch(params);
      return {
        results: r.results,
        screened: r.screened ?? 0,
        matched: r.matched ?? 0,
        partial: r.partial ?? false,
        elapsedMs: r.elapsedMs ?? 0,
      };
    }

    const start = Date.now();
    const state: PrescreenState = { screened: 0, partial: false };
    const results: SearchResult[] = [];
    const inFlight: Array<Promise<void>> = [];
    // Batches dispatched but not yet returned. `results` cannot reflect those, so
    // this is also how far the maxResults check below can lag behind reality.
    const pending = new Set<Promise<void>>();
    let batch: SearchResult[] = [];
    // Resolved once, before any batch is dispatched, so concurrent dispatches
    // can never race to create two pools.
    const pool = await this.#ensurePool();

    // Only the idCodes cross to the worker, and only positions come back: cloning
    // the candidate objects both ways measures 11x the strings-and-positions
    // round trip, which is 2% of a verification thrown away to save this map.
    const dispatch = (current: SearchResult[]): void => {
      const idCodes = new Array<string>(current.length);
      for (let i = 0; i < current.length; i++) {
        idCodes[i] = (current[i] as SearchResult).idCode;
      }
      const settled: Promise<void> = pool
        .verify(queryIdCode, idCodes)
        .then((matches) => {
          for (const match of matches) {
            const hit = current[match];
            if (hit) results.push(hit);
          }
        })
        .finally(() => pending.delete(settled));
      pending.add(settled);
      inFlight.push(settled);
    };

    // An empty fragment matches everything, so there is nothing to verify.
    const emptyFragment = mol.getAllAtoms() === 0;

    // A small maxResults would otherwise be overshot by a whole round of
    // full-size batches: the pool can have poolSize batches in flight, so cap the
    // batch such that one round screens roughly maxResults candidates rather than
    // poolSize * batchSize of them. Left at batchSize for an unbounded scan,
    // where there is nothing to overshoot and larger batches mean fewer trips.
    const effectiveBatch = Number.isFinite(maxResults)
      ? Math.max(1, Math.min(batchSize, Math.ceil(maxResults / poolSize)))
      : batchSize;

    for (const candidate of prescreen(params, state)) {
      const result: SearchResult = {
        entryId: candidate.entryId,
        idCode: candidate.idCode,
        mw: candidate.mw,
      };
      if (emptyFragment) {
        results.push(result);
        if (results.length >= maxResults) {
          state.partial = true;
          break;
        }
        continue;
      }
      batch.push(result);
      if (batch.length >= effectiveBatch) {
        dispatch(batch);
        batch = [];
        // Never run further than one batch per thread ahead of the results. Every
        // batch dispatched beyond that is work the maxResults check below cannot
        // yet see, so on a common fragment it is usually work thrown away. This
        // both yields the event loop (the prescreen runs on the calling thread)
        // and keeps the overshoot bounded.
        if (pending.size >= poolSize) {
          // eslint-disable-next-line no-await-in-loop -- intentional: throttle to poolSize batches in flight
          await Promise.race(pending);
        }
        // `results` still lags by whatever is in flight, so this can stop the
        // prescreen late — harmless, the extras are sorted and sliced off — but
        // never early, because every lighter candidate was already dispatched.
        if (results.length >= maxResults) {
          state.partial = true;
          break;
        }
      }
    }
    if (batch.length > 0) {
      if (inFlight.length === 0) {
        // The whole scan fits in one batch: checking a handful of molecules
        // inline is cheaper than spawning a thread to do it.
        results.push(
          ...(emptyFragment
            ? batch
            : substructureSearch(mol.getIDCode(), batch).matches),
        );
      } else {
        dispatch(batch);
      }
    }
    await Promise.all(inFlight);
    params.onProgress?.(state.screened, state.screened);

    // Batches complete out of order, so restore the lightest-first order the
    // prescreen produced before truncating to maxResults.
    const sorted = emptyFragment
      ? results
      : results.toSorted((a, b) => (a.mw ?? 0) - (b.mw ?? 0));
    if (sorted.length > maxResults) state.partial = true;
    const kept = sorted.slice(0, maxResults);
    return {
      results: kept,
      screened: state.screened,
      matched: kept.length,
      partial: state.partial,
      elapsedMs: Date.now() - start,
    };
  }

  // Run a full similarity scan (no pagination): Tanimoto over every indexed row.
  #scanSimilarityFull(
    mol: OCLMolecule,
    similarityThreshold: number,
    timeoutMs: number,
    candidates?: SearchCandidates,
  ): CachedScan {
    const { SSSearcherWithIndex } = this.#ocl;
    const start = Date.now();
    const queryIndex = mol.getIndex();
    const candidateJoin = candidates
      ? `JOIN (${candidates.sql}) c ON c.entry_id = e.${this.#cfg.pkColumn ?? 'id'}`
      : '';
    const stmt = this.#db.prepare(
      `SELECT ${this.#selectCols}, ${this.#ssIndexCols} FROM ${this.#cfg.entriesTable} e ${this.#ssJoin} ${candidateJoin}`,
    );
    stmt.setReadBigInts?.(true);
    const rows = stmt.all(
      ...(candidates?.params ? [candidates.params] : []),
    ) as Array<Record<string, unknown>>;
    const deadline = Date.now() + timeoutMs;
    const withSim: Array<SearchResult & { similarity: number }> = [];
    let partial = false;
    let screened = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      screened++;
      const targetIndex = unpackSSIndex(row);
      const sim = SSSearcherWithIndex.getSimilarityTanimoto(
        queryIndex,
        targetIndex,
      );
      if (sim >= similarityThreshold) {
        withSim.push({ ...rowToResult(row), similarity: sim });
      }
      if (i % 500 === 499 && Date.now() > deadline) {
        partial = true;
        break;
      }
    }
    const results = withSim.toSorted((a, b) => b.similarity - a.similarity);
    return {
      results,
      screened,
      matched: results.length,
      partial,
      elapsedMs: Date.now() - start,
    };
  }

  // Lazily create the verifier pool. The pool module (and node:worker_threads) is
  // dynamically imported so the synchronous path never loads it.
  async #ensurePool(): Promise<SearchWorkerPool> {
    if (!this.#pool) {
      const { SearchWorkerPool } = await import('./SearchWorkerPool.ts');
      this.#pool = new SearchWorkerPool({ poolSize: this.#cfg.poolSize });
    }
    return this.#pool;
  }
}
