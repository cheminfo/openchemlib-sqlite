import type * as OpenChemLib from 'openchemlib';

import type { SearchWorkerPool } from './SearchWorkerPool.ts';
import { buildSchemaSql } from './schema.ts';
// Type-only: erased at build, so node:worker_threads is never pulled into the
// synchronous/browser path. The pool is loaded lazily via dynamic import.
import type {
  MoleculesDBConfig,
  SQLiteDatabase,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from './types.ts';
import { packSSIndex, unpackSSIndex } from './utils/packSSIndex.ts';
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
}

function resolveConfig(config: MoleculesDBConfig): ResolvedConfig {
  return {
    entriesTable: config.entriesTable,
    pkColumn: config.pkColumn ?? 'id',
    idCodeColumn: config.idCodeColumn ?? 'id_code',
    idCodeNoStereoColumn: config.idCodeNoStereoColumn ?? null,
    mwColumn: config.mwColumn ?? null,
    poolSize: config.poolSize ?? 4,
  };
}

// The path of the main database file, derived from the connection itself (empty
// for an in-memory or temporary database). Workers reopen the file at this path,
// so the caller never has to pass it separately.
function databaseFilePath(db: SQLiteDatabase): string {
  const row = db
    .prepare("SELECT file FROM pragma_database_list WHERE name = 'main'")
    .get() as { file?: string } | undefined;
  return row?.file ?? '';
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
  #ssIndexCols: string;
  #ssJoin: string;
  #selectCols: string;
  #dbPath: string;
  #pool: SearchWorkerPool | undefined;

  constructor(db: SQLiteDatabase, ocl: OCLLibrary, config: MoleculesDBConfig) {
    this.#db = db;
    this.#ocl = ocl;
    this.#cfg = resolveConfig(config);
    this.#dbPath = databaseFilePath(db);

    const { pkColumn, idCodeColumn } = this.#cfg;
    this.#ssIndexCols =
      's.ss_index0, s.ss_index1, s.ss_index2, s.ss_index3, s.ss_index4, s.ss_index5, s.ss_index6, s.ss_index7';
    this.#ssJoin = `JOIN ocl_ss_index s ON s.entry_id = e.${pkColumn}`;
    this.#selectCols = `e.${pkColumn} AS entry_id, e.${idCodeColumn} AS id_code`;
  }

  /** Create the ocl_ss_index table (idempotent). */
  migrate(): void {
    this.#db.exec(buildSchemaSql(this.#cfg));
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
    const mol =
      typeof molecule === 'string'
        ? this.#ocl.Molecule.fromIDCode(molecule)
        : molecule;
    const packed = packSSIndex(mol.getIndex());

    this.#db
      .prepare(
        'INSERT OR REPLACE INTO ocl_ss_index (entry_id, ss_index0, ss_index1, ss_index2, ss_index3, ss_index4, ss_index5, ss_index6, ss_index7) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(entryId, ...packed);
  }

  /**
   * Search the database for molecules matching a query.
   *
   * Substructure search runs in a pool of worker threads when the instance was
   * created with a `dbPath` (see {@link MoleculesDBConfig}), so a large scan
   * never blocks the calling thread and is split across cores; otherwise it runs
   * synchronously on the calling thread. Either way the call is asynchronous.
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
      partition,
    } = options ?? {};

    const { entriesTable, idCodeColumn, idCodeNoStereoColumn, pkColumn } =
      this.#cfg;
    const { Molecule, SSSearcherWithIndex } = this.#ocl;

    const fromInstance = typeof query !== 'string';
    const baseMol: OCLMolecule =
      typeof query === 'string'
        ? parseMolecule(Molecule, query, format)
        : query;

    switch (mode) {
      case 'exact': {
        const mol = withFragment(baseMol, false, fromInstance);
        const idCode = mol.getIDCode();
        const rows = this.#db
          .prepare(
            `SELECT ${this.#selectCols} FROM ${entriesTable} e ${this.#ssJoin} WHERE e.${idCodeColumn} = ?`,
          )
          .all(idCode) as Array<Record<string, unknown>>;
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
        // stripStereoInformation always mutates, so always copy if fromInstance
        const mol = fromInstance ? baseMol.getCompactCopy() : baseMol;
        mol.setFragment(false);
        mol.stripStereoInformation();
        const idCodeNoStereo = mol.getIDCode();
        const rows = this.#db
          .prepare(
            `SELECT ${this.#selectCols} FROM ${entriesTable} e ${this.#ssJoin} WHERE e.${idCodeNoStereoColumn} = ?`,
          )
          .all(idCodeNoStereo) as Array<Record<string, unknown>>;
        return {
          results: rows.slice(from, from + limit).map(rowToResult),
          total: rows.length,
        };
      }

      case 'substructure': {
        const mol = withFragment(baseMol, true, fromInstance);
        const { mwColumn } = this.#cfg;

        // Parallel path: split the scan across worker threads. Skipped when this
        // call is itself a worker's partition (`partition` set) to avoid nesting.
        if (partition === undefined && this.#canParallelize()) {
          let queryMw = 0;
          if (mwColumn) {
            const mwMol = mol.getCompactCopy();
            mwMol.setFragment(false);
            queryMw = mwMol.getMolecularFormula().relativeWeight;
          }
          const pool = await this.#ensurePool();
          // Pass the query as an idCode so it is cheap to transfer to workers.
          return pool.runSubstructure(mol.getIDCode(), {
            format: 'idCode',
            from,
            limit,
            timeoutMs,
            maxResults,
            queryMw,
            sortByMw: mwColumn !== null,
            idRange: this.#ssIndexIdRange(),
            onProgress,
          });
        }

        return runSubstructureSearch({
          db: this.#db,
          ocl: this.#ocl,
          entriesTable,
          ssIndexCols: this.#ssIndexCols,
          mwColumn,
          pkColumn,
          idCodeColumn,
          mol,
          from,
          limit,
          timeoutMs,
          maxCandidates,
          maxResults,
          onProgress,
          partition,
        });
      }

      case 'similarity': {
        const mol = withFragment(baseMol, false, fromInstance);
        const queryIndex = mol.getIndex();
        const stmt = this.#db.prepare(
          `SELECT ${this.#selectCols}, ${this.#ssIndexCols} FROM ${entriesTable} e ${this.#ssJoin}`,
        );
        stmt.setReadBigInts?.(true);
        const rows = stmt.all() as Array<Record<string, unknown>>;

        const deadline = Date.now() + timeoutMs;
        const withSim: Array<SearchResult & { similarity: number }> = [];
        let partial = false;

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (!row) continue;
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

        const sorted = withSim.toSorted((a, b) => b.similarity - a.similarity);
        return {
          results: sorted.slice(from, from + limit),
          total: sorted.length,
          partial,
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

  // Parallel substructure search needs a file path each worker can open; an
  // in-memory or temporary database (empty path) cannot be shared across threads.
  #canParallelize(): boolean {
    return this.#dbPath !== '';
  }

  // Min/max entry_id, so the pool can split the scan into sargable PK ranges.
  #ssIndexIdRange(): { min: number; max: number } {
    const row = this.#db
      .prepare(
        'SELECT MIN(entry_id) AS lo, MAX(entry_id) AS hi FROM ocl_ss_index',
      )
      .get() as { lo: number | null; hi: number | null } | undefined;
    return { min: row?.lo ?? 0, max: row?.hi ?? 0 };
  }

  // Lazily create the worker pool. The pool module (and node:worker_threads) is
  // dynamically imported so the synchronous/browser path never loads it.
  async #ensurePool(): Promise<SearchWorkerPool> {
    if (!this.#pool) {
      const { SearchWorkerPool } = await import('./SearchWorkerPool.ts');
      const { poolSize, ...workerConfig } = this.#cfg;
      this.#pool = new SearchWorkerPool({
        dbPath: this.#dbPath,
        config: workerConfig,
        poolSize,
      });
    }
    return this.#pool;
  }
}
