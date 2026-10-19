import type { CountContext } from './countChunk.ts';
import type { CountOptions, Counts } from './countPage.ts';
import { countPage } from './countPage.ts';
import type { MoleculeIndexOptions } from './indexOptions.ts';
import type { Layout } from './layout.ts';
import type { IndexParts } from './openIndex.ts';
import { openParts } from './openIndex.ts';
import type { KeyPage, PageContext, SearchOptions } from './pages.ts';
import { keyPage } from './pages.ts';
import type { SearchPool } from './pool/SearchPool.ts';
import type { ScorePage, SimilarityOptions } from './scorePage.ts';
import { scorePage } from './scorePage.ts';
import type { SnapshotKeeper } from './snapshot/snapshotKeeper.ts';
import type { IndexSpec, NormalizedSpec } from './spec.ts';
import type { Tail } from './tail/Tail.ts';
import type { HungMemory } from './walk/verifySlice.ts';
import type { KeyCursor } from './walk/walkPage.ts';

/** Queries whose hung verifications are remembered, at most. */
const HUNG_QUERIES = 1024;

/**
 * The in-memory search engine over a store's file: the tiles loaded into bit planes, grouped by
 * atom count and band, followed through the commits; substructure searches, browse and similarity
 * answered in pages with a cursor, every page by its deadline. The application hands it, as SQL,
 * its order key, its filter columns, its id sets and its change log.
 */
export class MoleculeIndex {
  readonly #pool: SearchPool;
  readonly #tail: Tail | null;
  readonly #keeper: SnapshotKeeper | null;
  readonly #spec: NormalizedSpec;
  readonly #options: Required<MoleculeIndexOptions>;
  readonly #hung = new Map<string, HungMemory>();
  #current: Layout;
  #searches = 0;

  private constructor(parts: IndexParts) {
    this.#current = parts.tail?.current ?? parts.image.layout;
    this.#spec = parts.spec;
    this.#pool = parts.pool;
    this.#tail = parts.tail;
    this.#keeper = parts.keeper;
    this.#options = parts.options;
  }

  /**
   * Loads the index of a store's file, then follows it.
   * @param file - The SQLite file the store writes.
   * @param spec - The application's order key, filters, sets and change log, as SQL.
   * @param options - Threads, sizes and budgets.
   * @returns The index, ready to search.
   */
  static async open(
    file: string,
    spec: IndexSpec,
    options: MoleculeIndexOptions = {},
  ): Promise<MoleculeIndex> {
    const parts = await openParts(file, spec, options);
    const index = new MoleculeIndex(parts);
    parts.relay.onLayout = (layout) => {
      index.#current = layout;
    };
    // A version the tail published while the index was being made.
    if (parts.tail !== null) index.#current = parts.tail.current;
    return index;
  }

  /**
   * The version searched now.
   * @returns It; it grows by one for each change the tail publishes.
   */
  get version(): number {
    return this.#current.version;
  }

  /**
   * The watermark of the version searched now.
   * @returns The seq every molecule up to which is in the index.
   */
  get watermark(): number {
    return this.#current.watermark;
  }

  /**
   * The rows the index holds.
   * @returns Their count, removed molecules' rows included.
   */
  get rowCount(): number {
    return this.#current.rowCount;
  }

  /**
   * The sets the index holds a bitmap for.
   * @returns Their names.
   */
  get sets(): string[] {
    return [...this.#current.sets.keys()];
  }

  /**
   * Errors the tail met; a pruned change log needs the index loaded again.
   * @returns The messages.
   */
  get errors(): readonly string[] {
    return this.#tail?.errors ?? [];
  }

  /**
   * One page of a substructure search: the molecules holding the query, by order key then id.
   * @param queryIdCode - The query, read as a fragment.
   * @param options - Page size, restriction, filters, key bounds, budget, and the cursor.
   * @returns The page; `next` continues it exactly.
   */
  async substructure(
    queryIdCode: string,
    options: SearchOptions & { after?: KeyCursor } = {},
  ): Promise<KeyPage> {
    if (queryIdCode === '') throw new Error('an empty query: use browse()');
    return keyPage(this.#context(), queryIdCode, options, options.after);
  }

  /**
   * One page of a browse: every molecule, by order key then id.
   * @param options - Page size, restriction, filters, key bounds, budget, and the cursor.
   * @returns The page.
   */
  async browse(
    options: SearchOptions & { after?: KeyCursor } = {},
  ): Promise<KeyPage> {
    return keyPage(this.#context(), '', options, options.after);
  }

  /**
   * Counts the molecules a browse with these options answers, in the search workers: the sets, the
   * keys, the filter columns and the key bounds are all held in memory, so no row is read from SQL
   * (but the rare tied value of a filter, as in a search). The tallies come from the same pass. It
   * runs in chunks, each a turn of its lane, so an interactive search waits for one chunk at most.
   * @param options - The restriction and the tallies; `lane` defaults to 'bulk'. `budgetMs` counts
   * from the first chunk's start, and `signal` stops it.
   * @returns The counts; `complete` is false when the budget or the signal stopped it.
   */
  async count(options: CountOptions = {}): Promise<Counts> {
    const context: CountContext = {
      pool: this.#pool,
      current: () => this.#current,
      defaultSets: this.#spec.defaultSets,
      budgetMs: this.#options.budgetMs,
      chunkRows: this.#options.countChunkRows,
    };
    return countPage(context, options);
  }

  /**
   * One page of a similarity search on the fingerprint asked for, ranked by Tanimoto score then id.
   * @param idCode - The query molecule (a molecule, not a fragment).
   * @param options - The threshold (default 0.8), the fingerprint (default `'fragFp'`), the page's
   * options and the cursor, which must belong to the same fingerprint.
   * @returns The page; empty, with a `reason`, when the query sets no bit of the fingerprint.
   */
  async similarity(
    idCode: string,
    options: SimilarityOptions = {},
  ): Promise<ScorePage> {
    return scorePage(this.#context(), idCode, options);
  }

  /**
   * What the tail did so far.
   * @returns Its polls, rows placed, molecules read again from the change log, slots no tile held,
   * errors, append areas moved, blocks, version, watermark and last change applied; empty when the
   * index does not follow the file.
   */
  async tailStats(): Promise<Record<string, unknown>> {
    return (await this.#tail?.stats()) ?? {};
  }

  /**
   * Polls the file now (it is polled every `pollMs` anyway).
   * @returns Once what the file holds now is searchable.
   */
  async poll(): Promise<void> {
    await this.#tail?.poll();
  }

  /**
   * Resolves once every molecule up to a seq is searchable.
   * @param seq - The seq, e.g. the store's `lastSeq()` after a commit.
   * @param timeoutMs - Rejects after it.
   * @returns When it is.
   */
  async waitForSeq(seq: number, timeoutMs = 60_000): Promise<void> {
    if (this.#tail === null) {
      throw new Error('the index does not follow the file');
    }
    await this.#tail.waitForSeq(seq, timeoutMs);
  }

  /**
   * Saves the index to its snapshot now, as a load lays it out, the tail paused meanwhile. It is
   * saved by itself once the tail took in `snapshotRefreshShare` of the snapshot's rows.
   * @returns Null once saved, or why it was not.
   */
  async saveSnapshot(): Promise<string | null> {
    if (this.#keeper === null) {
      return 'not saved: the index has no snapshot, or does not follow its file';
    }
    return this.#keeper.save();
  }

  /** Stops a snapshot save running, the tail and the workers. */
  async close(): Promise<void> {
    await this.#keeper?.close();
    await this.#tail?.close();
    await this.#pool.close();
  }

  #context(): PageContext {
    return {
      pool: this.#pool,
      layout: this.#current,
      defaultSets: this.#spec.defaultSets,
      budgetMs: this.#options.budgetMs,
      firstSliceRows: this.#options.firstSliceRows,
      similarityUnitWords: this.#options.similarityUnitWords,
      verify: {
        chunkMinMs: this.#options.verifyChunkMinMs,
        chunkFactor: this.#options.verifyChunkFactor,
        singleMs: this.#options.verifySingleMs,
      },
      hung: (key) => this.#hungOf(key),
      searchId: ++this.#searches,
    };
  }

  #hungOf(key: string): HungMemory {
    let entry = this.#hung.get(key);
    if (entry === undefined) {
      entry = { unverified: new Map(), suspects: new Map() };
      this.#hung.set(key, entry);
      if (this.#hung.size > HUNG_QUERIES) {
        this.#hung.delete(this.#hung.keys().next().value as string);
      }
    }
    return entry;
  }
}
