import type * as OpenChemLib from 'openchemlib';

import { buildSchemaSql } from './schema.ts';
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
}

function resolveConfig(config: MoleculesDBConfig): ResolvedConfig {
  return {
    entriesTable: config.entriesTable,
    pkColumn: config.pkColumn ?? 'id',
    idCodeColumn: config.idCodeColumn ?? 'id_code',
    idCodeNoStereoColumn: config.idCodeNoStereoColumn ?? null,
    mwColumn: config.mwColumn ?? null,
  };
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

  constructor(db: SQLiteDatabase, ocl: OCLLibrary, config: MoleculesDBConfig) {
    this.#db = db;
    this.#ocl = ocl;
    this.#cfg = resolveConfig(config);

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
   * Substructure and similarity searches scan all candidate rows and may be
   * slow on large databases; use timeoutMs to cap execution time.
   * @param query - Query molecule as an OCL Molecule instance or as a string
   *   parsed according to options.format (ignored when a Molecule is passed).
   * @param options - Search options.
   * @returns Search response containing results and metadata.
   */
  search(query: string | OCLMolecule, options?: SearchOptions): SearchResponse {
    const {
      mode = 'exact',
      format = 'smiles',
      similarityThreshold = 0.5,
      limit = Number.MAX_SAFE_INTEGER,
      from = 0,
      timeoutMs = 5000,
    } = options ?? {};

    const { entriesTable, idCodeColumn, idCodeNoStereoColumn } = this.#cfg;
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
        return runSubstructureSearch({
          db: this.#db,
          ocl: this.#ocl,
          entriesTable,
          selectCols: this.#selectCols,
          ssIndexCols: this.#ssIndexCols,
          ssJoin: this.#ssJoin,
          mwColumn,
          mol,
          from,
          limit,
          timeoutMs,
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
}
