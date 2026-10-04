import { availableParallelism } from 'node:os';

import { LRUCache } from 'lru-cache';
import type * as OpenChemLib from 'openchemlib';
import { getIndex, substructureSearch } from 'openchemlib-search-wasm';

import type { SearchWorkerPool } from './SearchWorkerPool.ts';
import { SCHEMA_VERSION, runMigrations } from './migrations.ts';
import type { FoldOptions, FoldResult } from './planes/foldPlanes.ts';
import { foldPlanes } from './planes/foldPlanes.ts';
import type { PlaneStatus } from './planes/planeStatus.ts';
import { planeStatusOf } from './planes/planeStatus.ts';
import {
  MAX_TAUTOMERS_SETTING,
  NO_STEREO_HASH_TABLE,
  NO_STEREO_TAUTOMER_HASH_TABLE,
  SETTINGS_TABLE,
  buildHashTableSql,
} from './schema.ts';
// Type-only: erased at build, so node:worker_threads is never pulled into the
// synchronous/browser path. The pool is loaded lazily via dynamic import.
import type {
  BackfillOptions,
  BackfillResult,
  ColumnRange,
  ColumnStatus,
  FillColumnsOptions,
  FillColumnsResult,
  IndexColumnType,
  MigrateOptions,
  MoleculesDBConfig,
  MwRange,
  PrecomputedEntry,
  SQLiteDatabase,
  SQLiteStatement,
  ScanPosition,
  SearchCandidates,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from './types.ts';
import { backfillHashes } from './utils/backfillHashes.ts';
import { buildStaleBitsTriggerSql } from './utils/bitsColumn.ts';
import type { ColumnReader } from './utils/fillColumns.ts';
import { fillColumns } from './utils/fillColumns.ts';
import { fingerprintBits } from './utils/fingerprintBits.ts';
import type { ColumnConditions } from './utils/indexColumns.ts';
import {
  BITS_COLUMN,
  boundableColumns,
  columnConditions,
  columnSqlName,
  columnStatusOf,
  reconcileColumns,
} from './utils/indexColumns.ts';
import { buildInsertSql, columnValues } from './utils/insertRow.ts';
import { packGivenIndex, packSSIndex } from './utils/packSSIndex.ts';
import type { PrescreenState } from './utils/prescreen.ts';
import { prescreen } from './utils/prescreen.ts';
import type { EntryRestriction } from './utils/restrictEntries.ts';
import { restrictEntries, restrictionKey } from './utils/restrictEntries.ts';
import { runSubstructureSearch } from './utils/runSubstructureSearch.ts';
import {
  byWeight,
  parseMolecule,
  resumePosition,
  rowToResult,
} from './utils/searchHelpers.ts';
import type { CachedScan } from './utils/similarityScan.ts';
import { scanSimilarity } from './utils/similarityScan.ts';
import type { HashKind } from './utils/structureHash.ts';
import { DEFAULT_MAX_TAUTOMERS, structureHash } from './utils/structureHash.ts';

type OCLLibrary = typeof OpenChemLib;
type OCLMolecule = InstanceType<OCLLibrary['Molecule']>;

interface ResolvedConfig {
  entriesTable: string;
  pkColumn: string;
  idCodeColumn: string;
  mwColumn: string | null;
  trustMwColumn: boolean;
  planeCandidateRatio: number;
  poolSize: number;
  batchSize: number;
  searchCacheSize: number;
  maxTautomers: number;
  /** The carried columns, by SQL name. */
  columns: Map<string, IndexColumnType>;
}

function resolveConfig(config: MoleculesDBConfig): ResolvedConfig {
  const columns = new Map<string, IndexColumnType>();
  for (const [name, type] of Object.entries(config.columns ?? {})) {
    columns.set(columnSqlName(name), type);
  }
  return {
    columns,
    entriesTable: config.entriesTable,
    pkColumn: config.pkColumn ?? 'id',
    idCodeColumn: config.idCodeColumn ?? 'id_code',
    mwColumn: config.mwColumn ?? null,
    trustMwColumn: config.trustMwColumn ?? false,
    planeCandidateRatio: config.planeCandidateRatio ?? 0.01,
    poolSize: config.poolSize ?? availableParallelism(),
    batchSize: config.batchSize ?? 1024,
    searchCacheSize: config.searchCacheSize ?? 100,
    maxTautomers: config.maxTautomers ?? DEFAULT_MAX_TAUTOMERS,
  };
}

/** Everything a hash lookup needs beyond the hash itself. */
interface HashLookup {
  /** The caller's entries table. */
  entriesTable: string;
  /** Its primary key column. */
  pkColumn: string;
  /** The caller's candidates and weight range, as SQL. */
  restriction: EntryRestriction;
  /** Result offset. */
  from: number;
  /** Maximum results to return. */
  limit: number;
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

export class MoleculesDBSQLite {
  #db: SQLiteDatabase;
  #ocl: OCLLibrary;
  #cfg: ResolvedConfig;
  #ssJoin: string;
  #selectCols: string;
  #pool: SearchWorkerPool | undefined;
  #searchCache: LRUCache<string, CachedScan> | undefined;
  /**
   * The statements `insert()` writes with, prepared on first use. Preparing
   * one is most of what writing a precomputed entry costs, and a bulk load
   * writes millions.
   */
  #insertStatements: { row?: SQLiteStatement; fromColumn?: SQLiteStatement } =
    {};

  constructor(db: SQLiteDatabase, ocl: OCLLibrary, config: MoleculesDBConfig) {
    this.#db = db;
    this.#ocl = ocl;
    this.#cfg = resolveConfig(config);
    this.#searchCache =
      this.#cfg.searchCacheSize > 0
        ? new LRUCache<string, CachedScan>({ max: this.#cfg.searchCacheSize })
        : undefined;

    const { pkColumn, idCodeColumn } = this.#cfg;
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
    const { entriesTable, pkColumn, idCodeColumn, mwColumn, columns } =
      this.#cfg;
    const applied = runMigrations({
      db: this.#db,
      ocl: this.#ocl,
      entriesTable,
      pkColumn,
      idCodeColumn,
      mwColumn,
      onMigration: options.onMigration,
    });
    // The columns this instance declares, added to the index if it lacks them,
    // with the library's own bit count, which an in-place change of a
    // fingerprint must not leave stale.
    reconcileColumns(this.#db, new Map([[BITS_COLUMN, 'integer'], ...columns]));
    this.#db.exec(buildStaleBitsTriggerSql());
    // A migration may have rewritten the table those statements were written
    // for, so they are prepared again on the next insert.
    this.#insertStatements = {};
    const rebuilt = this.#reconcileCeiling(options);
    // A rewritten index invalidates anything cached from the old one.
    if (applied.length > 0 || rebuilt) this.#searchCache?.clear();
    return applied;
  }

  /**
   * Rebuild the tautomer hash table when the ceiling it was filled under is not
   * the one this instance is configured with.
   *
   * Which molecules have a tautomer hash depends on the ceiling, and `search()`
   * hashes its query under the configured one. Left alone, raising or lowering
   * it would make a query hash that no stored hash was ever going to equal, and
   * the mode would quietly return nothing. So the table is emptied and
   * `backfillHashes()` fills it again under the new ceiling.
   *
   * The no-stereo table is untouched: it enumerates no tautomers, so no ceiling
   * applies to it.
   * @param options - The migration log callback, so a rebuild is not silent.
   * @returns Whether the table was rebuilt.
   */
  #reconcileCeiling(options: MigrateOptions): boolean {
    const { entriesTable, pkColumn, maxTautomers } = this.#cfg;
    const wanted = String(maxTautomers);
    const recorded = (
      this.#db
        .prepare(
          `SELECT value FROM ${SETTINGS_TABLE} WHERE name = '${MAX_TAUTOMERS_SETTING}'`,
        )
        .get() as { value: string } | undefined
    )?.value;

    if (recorded === wanted) return false;

    // Only rows already filled under the old ceiling have to go. An empty table
    // — a fresh database, or one whose backfill has not run — is simply recorded
    // against the new one, so a reconfigured ceiling costs nothing until there
    // is something to lose.
    const filled =
      (
        this.#db
          .prepare(`SELECT COUNT(*) AS n FROM ${NO_STEREO_TAUTOMER_HASH_TABLE}`)
          .get() as { n: number }
      ).n > 0;

    if (filled) {
      options.onMigration?.({
        version: SCHEMA_VERSION,
        description: `rebuild ${NO_STEREO_TAUTOMER_HASH_TABLE}: maxTautomers ${recorded ?? 'unrecorded'} -> ${wanted}`,
        phase: 'start',
      });
      this.#db.exec(`DROP TABLE IF EXISTS ${NO_STEREO_TAUTOMER_HASH_TABLE}`);
      this.#db.exec(
        buildHashTableSql(
          { entriesTable, pkColumn },
          NO_STEREO_TAUTOMER_HASH_TABLE,
        ),
      );
    }

    this.#db
      .prepare(
        `INSERT INTO ${SETTINGS_TABLE} (name, value) VALUES ('${MAX_TAUTOMERS_SETTING}', ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      )
      .run(wanted);
    return filled;
  }

  /**
   * Fold the entries above the watermark into the plane index.
   *
   * The plane index is the transposed form of `ocl_ss_index`: one bitmap per
   * fingerprint bit, so a substructure prescreen reads only the planes of the
   * bits its query sets instead of every entry's key. Measured on 2 M entries
   * that takes the screen from 216 ms–10.5 s to 1–9 ms, and because it does not
   * grow with the library the saving grows with it.
   *
   * It is filled here rather than at `insert()` because one molecule sets 74–348
   * of its 512 bits, so writing those in place would rewrite a chunk of each of
   * that many planes per insert. A fold appends whole chunks of 2^20 entries
   * instead, which comes to 64 bytes a molecule — the size of the fingerprint
   * itself.
   *
   * The planes are trusted for the entries up to a watermark, the highest id
   * the last fold covered; every entry above it is read from `ocl_ss_index`,
   * which is where `insert()` writes and all it writes. That is exact as long
   * as **entry ids only grow**. A write at or below the watermark — a new id
   * below it, an entry inserted again with another fingerprint, an id given
   * again after its entry was removed — lowers the watermark below that id, so
   * searches stay exact and slow down to the unfolded speed for what lies
   * above it, until this is called again.
   *
   * Call it after a bulk load, and periodically afterwards: between folds the
   * entries above the watermark grow and search slowly returns to its unfolded
   * speed. It is resumable and commits per chunk, so interrupting it loses only
   * the chunk in progress. Nothing has to be folded for the database to work —
   * until it is, every search simply takes the column path.
   * @param options - What to store, and how much to do in one call.
   * @returns What this call folded, and whether anything is still waiting.
   */
  foldPlanes(options: FoldOptions = {}): FoldResult {
    const result = foldPlanes(this.#db, options);
    // Which prescreen a query takes now depends on what is folded, so an
    // answer cached before this call was reached by a different route.
    this.clearSearchCache();
    return result;
  }

  /**
   * What the plane index currently covers, and whether to fold again.
   *
   * `pending` counts the entries above the watermark: what `foldPlanes()` would
   * pick up, and what every search still screens the slower way. It is counted
   * through the entry index, so before the first fold it walks every entry.
   * `refoldAdvisable` says when folding now would make searches faster.
   * @returns The status of the plane index.
   */
  planeStatus(): PlaneStatus {
    return planeStatusOf(this.#db);
  }

  /**
   * The columns the index carries, and whether every entry has a value in
   * each — a search may bound only those that are complete and declared.
   * @returns One status per column.
   */
  columnStatus(): ColumnStatus[] {
    return columnStatusOf(this.#db, this.#cfg.columns);
  }

  /**
   * Fill the carried columns of the entries indexed before those columns
   * were declared.
   *
   * Declaring a column on an index that already holds entries adds it to
   * `ocl_ss_index` at once and empty: a search may not bound it until every
   * entry has its value. This walks those entries in id order, a chunk per
   * short transaction, asks `read` for their values and writes them; an entry
   * it returns nothing for is stored NULL. Resumable — progress is committed
   * with each chunk — and it yields between chunks, so run it in the
   * background, as `backfillHashes()` is.
   * @param read - Returns the values of the declared columns for some entries;
   *   it may be left out while none of them is pending.
   * @param options - Chunk size, limit, progress and abort signal.
   * @returns What this call filled, and whether anything is still pending.
   */
  async fillColumns(
    read?: ColumnReader,
    options: FillColumnsOptions = {},
  ): Promise<FillColumnsResult> {
    const result = await fillColumns(
      this.#db,
      this.#cfg.columns,
      read,
      options,
    );
    if (result.filled > 0) this.#searchCache?.clear();
    return result;
  }

  /**
   * Take an entry out of the index: its fingerprint, its structure hashes, and
   * — through a trigger on `ocl_ss_index` — its slot.
   *
   * Call it before deleting the entry itself. In one database the index's
   * foreign keys refuse to delete an entry that is still indexed.
   *
   * Its bits stay in the planes, since a chunk is never rewritten; with no slot
   * to resolve to they answer nothing, but they still count as survivors when
   * the router weighs a query. The watermark does not move, so removing entries
   * never slows a search down; an id given to a new entry afterwards is
   * another matter — see `foldPlanes()`.
   * @param entryId - Primary key of the entry in the entries table.
   */
  remove(entryId: number): void {
    for (const table of [
      'ocl_ss_index',
      NO_STEREO_HASH_TABLE,
      NO_STEREO_TAUTOMER_HASH_TABLE,
    ]) {
      this.#db.prepare(`DELETE FROM ${table} WHERE entry_id = ?`).run(entryId);
    }
    this.#searchCache?.clear();
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
   *
   * Give entries **ids that only grow**, and index them in that order. An entry
   * above the watermark of the plane index never touches it; one written at or
   * below it — a smaller new id, or an entry inserted again with another
   * fingerprint — is found all the same, but lowers the watermark below it, so
   * searches lose the plane index's speed for every entry above it until the
   * next `foldPlanes()`. Inserting an entry again with the same fingerprint
   * changes nothing.
   * @param entryId - Primary key of the entry in the entries table.
   * @param molecule - OCL Molecule instance or idCode string.
   * @param precomputed - Values the caller already holds, so this does not
   *   compute them again. Anything absent is derived from the molecule as
   *   before; with both `index` and `mw` given, no chemistry is done here at all
   *   and the molecule is never read.
   */
  insert(
    entryId: number,
    molecule: string | OCLMolecule,
    precomputed: PrecomputedEntry = {},
  ): void {
    const { mwColumn, entriesTable, pkColumn } = this.#cfg;
    // Building the fingerprint is ~99% of what indexing an entry costs, so from an idCode it is
    // built by openchemlib-search-wasm (~920 µs) rather than openchemlib-js (~4491 µs). The words
    // are the same, bit for bit, and a BigInt64Array over them is already the eight columns below.
    // A Molecule the caller passed in cannot take that path without being re-encoded, so it keeps
    // its own fingerprint. A caller holding one already passes it and this costs nothing.
    let packed: bigint[];
    if (precomputed.index !== undefined) {
      packed = packGivenIndex(precomputed.index);
    } else if (typeof molecule === 'string') {
      packed = Array.from(new BigInt64Array(getIndex(molecule).buffer, 0, 8));
    } else {
      packed = packSSIndex(molecule.getIndex());
    }

    // The fingerprint's bit count first, which bounds what a similarity
    // search can find in this entry, then the caller's columns.
    const columns = [BITS_COLUMN, ...this.#cfg.columns.keys()];
    const values = [
      fingerprintBits(packed),
      ...columnValues([...this.#cfg.columns.keys()], precomputed.columns),
    ];
    if (precomputed.mw !== undefined) {
      this.#insertIndexRow(entryId, precomputed.mw, packed, values);
    } else if (mwColumn) {
      // Take mw from the entries table so the clustered order matches whatever
      // a bulk index path stores; the entry already exists there.
      this.#insertStatements.fromColumn ??= this.#db.prepare(
        buildInsertSql(columns, { mwColumn, entriesTable, pkColumn }),
      );
      this.#insertStatements.fromColumn.run(
        entryId,
        entryId,
        ...packed,
        ...values,
      );
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
      this.#insertIndexRow(entryId, mw, packed, values);
    }
    // The data changed, so cached search results are stale.
    this.#searchCache?.clear();
  }

  /**
   * Write one row of the fingerprint index, weight and all.
   * @param entryId - Primary key of the entry.
   * @param mw - The weight the index is clustered by.
   * @param packed - The eight 64-bit fingerprint words.
   * @param values - The bit count, then the carried columns' values in
   *   declaration order.
   */
  #insertIndexRow(
    entryId: number,
    mw: number,
    packed: bigint[],
    values: Array<number | null>,
  ): void {
    this.#insertStatements.row ??= this.#db.prepare(
      buildInsertSql([BITS_COLUMN, ...this.#cfg.columns.keys()]),
    );
    this.#insertStatements.row.run(mw, entryId, ...packed, ...values);
  }

  /**
   * Whether the index's `mw` can be relied on to be the molecular weight.
   *
   * Only when `insert()` computed it from the molecule. A configured `mwColumn`
   * is the caller's column and may mean something else entirely, so the weight
   * floor the prescreen can seek on stays off for it unless the caller says
   * otherwise with `trustMwColumn`.
   * @returns True when a weight floor may be applied to the prescreen.
   */
  #mwIsMolecularWeight(): boolean {
    return this.#cfg.mwColumn === null || this.#cfg.trustMwColumn;
  }

  /**
   * A search's bounds on carried columns, as conditions on `s`.
   * @param ranges - The bounds, by the caller's names.
   * @returns The conditions, or undefined when there are none.
   * @throws {Error} When a bound names a column the index does not carry in full.
   */
  #columnBounds(
    ranges: Record<string, ColumnRange> | undefined,
  ): ColumnConditions | undefined {
    if (ranges === undefined || Object.keys(ranges).length === 0) {
      return undefined;
    }
    return columnConditions(
      ranges,
      boundableColumns(this.#db, this.#cfg.columns),
    );
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
   * `poolSize`, so one query always gives one answer — and for a molfile bond query
   * feature it is the right one. Setting the fragment flag after parsing a molfile
   * leaves the drawn bond order allowed alongside the query alternatives, so a bond
   * drawn "double or aromatic" would match a single bond too; encoding the query to
   * an idCode normalizes it away.
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
      mwRange,
      after,
      columnRanges,
    } = options ?? {};

    const { entriesTable, idCodeColumn, pkColumn } = this.#cfg;
    const { Molecule } = this.#ocl;

    // Restricting the entries table to the candidates, the weight range and
    // the bounds on carried columns. Every mode honours all three, so a caller
    // can never get unfiltered results by picking one. The exact modes read a
    // handful of rows, so they test each.
    const columnBounds = this.#columnBounds(columnRanges);
    const restriction = restrictEntries(
      pkColumn,
      true,
      candidates,
      mwRange,
      columnBounds,
    );
    const key = restrictionKey(candidates, mwRange, columnRanges);

    const fromInstance = typeof query !== 'string';
    // Parsing is deferred to each mode: only the modes that re-encode the query
    // to a canonical idCode need 2D coordinates invented, and `exact` on an
    // idCode does not even need to parse (see below).
    const parse = (ensureCoordinates: boolean): OCLMolecule =>
      typeof query === 'string'
        ? parseMolecule(Molecule, query, format, ensureCoordinates)
        : query;
    // Both hash modes key on the query's idCode. An idCode query is used as the
    // string it already is: re-encoding it would invent coordinates for nothing
    // and is not even lossless. No coordinates otherwise — both hashes are
    // graph-derived, and inventing them is ~20x the parse.
    const queryIdCode = (): string =>
      typeof query === 'string' && format === 'idCode'
        ? query
        : withFragment(parse(false), false, fromInstance).getIDCode();

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
            `SELECT ${this.#selectCols} FROM ${entriesTable} e ${this.#ssJoin} ${restriction.join} WHERE e.${idCodeColumn} = ?${restriction.where}`,
          )
          .all(...restriction.named, idCode, ...restriction.values) as Array<
          Record<string, unknown>
        >;
        return {
          results: rows.slice(from, from + limit).map(rowToResult),
          total: rows.length,
        };
      }

      case 'exactNoStereo':
        return this.#searchByHash(
          'noStereo',
          NO_STEREO_HASH_TABLE,
          queryIdCode(),
          { entriesTable, pkColumn, restriction, from, limit },
        );

      case 'exactNoStereoTautomer':
        return this.#searchByHash(
          'noStereoTautomer',
          NO_STEREO_TAUTOMER_HASH_TABLE,
          queryIdCode(),
          { entriesTable, pkColumn, restriction, from, limit },
        );

      case 'substructure': {
        // No coordinates: the fingerprint prefilter and the graph match are both
        // coordinate-independent, and inventing them is ~20x the parse.
        const mol = withFragment(parse(false), true, fromInstance);
        const queryIdCode = mol.getIDCode();
        const scan = await this.#cachedScan(
          `sub|${queryIdCode}|${maxResults}|${maxCandidates}|${key}|${after === undefined ? '' : `${after.mw}:${after.entryId}`}`,
          () =>
            this.#scanSubstructureFull(
              mol,
              queryIdCode,
              { maxResults, maxCandidates, timeoutMs, onProgress },
              { candidates, mwRange, after, columnBounds },
            ),
        );
        return {
          results: scan.results.slice(from, from + limit),
          total: scan.results.length,
          screened: scan.screened,
          matched: scan.matched,
          partial: scan.partial,
          elapsedMs: scan.elapsedMs,
          timedOut: scan.timedOut,
          ...(scan.resume === undefined ? {} : { resume: scan.resume }),
        };
      }

      case 'similarity': {
        // No coordinates: Tanimoto runs on the fingerprint, which is derived
        // from the graph alone.
        const mol = withFragment(parse(false), false, fromInstance);
        const queryIdCode = mol.getIDCode();
        const scan = await this.#cachedScan(
          `sim|${queryIdCode}|${similarityThreshold}|${key}`,
          () =>
            Promise.resolve(
              scanSimilarity({
                db: this.#db,
                ocl: this.#ocl,
                entriesTable,
                pkColumn,
                idCodeColumn,
                queryIndex: mol.getIndex(),
                threshold: similarityThreshold,
                timeoutMs,
                restriction: restrictEntries(
                  pkColumn,
                  false,
                  candidates,
                  mwRange,
                  columnBounds,
                ),
              }),
            ),
        );
        return {
          results: scan.results.slice(from, from + limit),
          total: scan.results.length,
          partial: scan.partial,
          elapsedMs: scan.elapsedMs,
          timedOut: scan.timedOut,
        };
      }

      default:
        throw new Error(`Unknown search mode: ${String(mode)}`);
    }
  }

  /**
   * Compute every structure hash that is missing, so `exactNoStereo` and
   * `exactNoStereoTautomer` can find those entries.
   *
   * **Run this in the background, not during startup.** It runs two passes, and
   * the cheap one goes first on purpose: the no-stereo hash costs ~74 µs a
   * molecule where the tautomer hash averages ~22 ms, so `exactNoStereo` becomes
   * completely searchable in well under a minute on a corpus where
   * `exactNoStereoTautomer` is still hours away. A pass finishes before the next
   * starts, so neither mode is left half-answered for the length of the run.
   *
   * It is **resumable and interruptible**. Work is committed a chunk at a time
   * and an entry is marked done by the presence of its row, so an interrupted
   * run loses at most one chunk and the next call continues from there — nothing
   * is ever recomputed. Pass `limit` to bound each pass, or `signal` to stop at
   * the next chunk boundary.
   *
   * A molecule the cap stops is stored as NULL, and so is one OpenChemLib cannot
   * hash. Both mean the same thing to a search — this entry has no such hash —
   * and neither is retried by a later run.
   * @param options - Concurrency, the per-molecule cap, and progress reporting.
   * @returns One result per pass, plus the totals.
   * @example
   * ```js
   * // after migrate(), off the startup path
   * const result = await molDB.backfillHashes({
   *   onProgress: (progress) => logger.info(progress, 'hash backfill'),
   * });
   * ```
   */
  async backfillHashes(options: BackfillOptions = {}): Promise<BackfillResult> {
    const { entriesTable, pkColumn, idCodeColumn, poolSize, maxTautomers } =
      this.#cfg;
    const result = await backfillHashes(
      { db: this.#db, entriesTable, pkColumn, idCodeColumn },
      { poolSize, maxTautomers, ...options },
    );
    // Entries that had no hash can now match, so anything cached is stale.
    if (result.hashed > 0) this.#searchCache?.clear();
    return result;
  }

  /**
   * Look entries up by one of the two structure hashes.
   * @param kind - Which hash to key on.
   * @param table - The table holding it.
   * @param idCode - The query, as an idCode.
   * @param sql - Where to look and how much to return.
   * @returns The matching entries.
   */
  #searchByHash(
    kind: HashKind,
    table: string,
    idCode: string,
    sql: HashLookup,
  ): SearchResponse {
    // A query OCL cannot hash matches nothing, rather than raising the opaque
    // error the canonizer throws on a malformed idCode.
    const hash = structureHash(kind, idCode, this.#cfg.maxTautomers);
    if (hash === null) return { results: [], total: 0 };
    const { entriesTable, pkColumn, restriction, from, limit } = sql;
    const rows = this.#db
      .prepare(
        `SELECT ${this.#selectCols} FROM ${entriesTable} e ${this.#ssJoin} ${restriction.join} JOIN ${table} h ON h.entry_id = e.${pkColumn} WHERE h.hash = ?${restriction.where}`,
      )
      .all(...restriction.named, hash, ...restriction.values) as Array<
      Record<string, unknown>
    >;
    return {
      results: rows.slice(from, from + limit).map(rowToResult),
      total: rows.length,
    };
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
  //
  // A scan the clock stopped is not stored: the key holds no timeout, and what
  // the scan reached depends on the load at the time, so the next identical
  // search must get the chance to answer in full.
  async #cachedScan(
    key: string,
    computeFull: () => Promise<CachedScan>,
  ): Promise<CachedScan> {
    const hit = this.#searchCache?.get(key);
    if (hit) return hit;
    const scan = await computeFull();
    if (!scan.timedOut) this.#searchCache?.set(key, scan);
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
    bounds: Pick<
      Required<SearchOptions>,
      'maxResults' | 'maxCandidates' | 'timeoutMs'
    > &
      Pick<SearchOptions, 'onProgress'>,
    restriction: {
      candidates?: SearchCandidates;
      mwRange?: MwRange;
      after?: ScanPosition;
      columnBounds?: ColumnConditions;
    },
  ): Promise<CachedScan> {
    const { maxResults, maxCandidates, timeoutMs, onProgress } = bounds;
    const { candidates, mwRange, after, columnBounds } = restriction;
    const {
      entriesTable,
      pkColumn,
      idCodeColumn,
      poolSize,
      batchSize,
      planeCandidateRatio,
    } = this.#cfg;
    const params = {
      db: this.#db,
      ocl: this.#ocl,
      entriesTable,
      pkColumn,
      idCodeColumn,
      mwIsMolecularWeight: this.#mwIsMolecularWeight(),
      planeCandidateRatio,
      mol,
      from: 0,
      limit: Number.MAX_SAFE_INTEGER,
      timeoutMs,
      maxCandidates,
      maxResults,
      onProgress,
      candidates,
      mwRange,
      after,
      columnBounds,
    };
    if (poolSize <= 1) {
      const r = runSubstructureSearch(params);
      return {
        results: r.results,
        screened: r.screened ?? 0,
        matched: r.matched ?? 0,
        partial: r.partial ?? false,
        elapsedMs: r.elapsedMs ?? 0,
        timedOut: r.timedOut ?? false,
        ...(r.resume === undefined ? {} : { resume: r.resume }),
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
          // What the prescreen weighs a switch to the planes with.
          state.verified = (state.verified ?? 0) + current.length;
          state.matched = results.length;
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

    let lastRead: SearchResult | undefined;
    for (const candidate of prescreen(params, state)) {
      const result: SearchResult = {
        entryId: candidate.entryId,
        idCode: candidate.idCode,
        mw: candidate.mw,
      };
      lastRead = result;
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

    // Batches complete out of order, so restore the order the prescreen
    // produced — weight, then entry id — before truncating to maxResults.
    const sorted = emptyFragment ? results : results.toSorted(byWeight);
    if (sorted.length > maxResults) state.partial = true;
    const kept = sorted.slice(0, maxResults);
    const resume = resumePosition(kept, maxResults, state, lastRead, after);
    return {
      results: kept,
      screened: state.screened,
      matched: kept.length,
      partial: state.partial,
      elapsedMs: Date.now() - start,
      timedOut: state.timedOut === true,
      ...(resume === undefined ? {} : { resume }),
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
