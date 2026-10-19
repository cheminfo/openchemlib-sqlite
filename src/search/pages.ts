import { readKeyBits } from './keyBits.ts';
import type { Layout } from './layout.ts';
import type { SearchPool } from './pool/SearchPool.ts';
import type { FilterRange } from './query.ts';
import { readFilters, restrictionRank, substructurePlan } from './query.ts';
import { setExpression } from './setExpression.ts';
import type { HungMemory } from './walk/verifySlice.ts';
import type { KeyCursor } from './walk/walkPage.ts';
import { after as isAfter, walkPage } from './walk/walkPage.ts';

/**
 * Keys a row holds or lacks, as bits of the 48-word record `getMoleculeRecords` writes, numbered
 * MSB first: bit b is word `b >> 5`, mask `1 << (31 - (b & 31))`. FragFp is 0-511, the screen
 * 512-1023, the function keys 1024-1535. They are stored, so a condition on them is exact and needs
 * no verification.
 */
export interface KeyBits {
  /**
   * Bits an answered row holds, every one.
   * @default []
   */
  all?: readonly number[];
  /**
   * Bits of which an answered row holds at least one. Empty, it puts no condition.
   * @default []
   */
  any?: readonly number[];
  /**
   * Bits an answered row holds none of.
   * @default []
   */
  none?: readonly number[];
}

/** Which queue a search waits in when the workers are busy. */
export type SearchLane = 'interactive' | 'bulk';

/** What every search takes. */
export interface SearchOptions {
  /**
   * Hits per page at most.
   * @default 24
   */
  limit?: number;
  /**
   * The sets an answered row belongs to at least one of (their union), e.g. `['listed']` or
   * `['source:3']`. Unknown names add nothing; when no name is known, or `[]`, nothing answers.
   * @default the index's `defaultSets`; every alive row when it has none
   */
  sets?: string[];
  /**
   * Sets an answered row belongs to, every one. An unknown name answers nothing.
   * @default []
   */
  allSets?: string[];
  /**
   * Sets an answered row belongs to none of. An unknown name removes nothing.
   * @default []
   */
  noneSets?: string[];
  /**
   * Keys an answered row holds or lacks. A browse with keys is answered without any verification,
   * and a substructure search verifies its query alone.
   * @default {}
   */
  bits?: KeyBits;
  /** Inclusive bounds on filter columns, by name. */
  filters?: Record<string, FilterRange>;
  /**
   * The least order key answered: a seek, not a filter.
   * @default -Infinity
   */
  keyMin?: number;
  /**
   * The largest order key answered.
   * @default Infinity
   */
  keyMax?: number;
  /**
   * The queue the search waits in. An interactive search runs before any bulk one waiting, and its
   * budget counts from the call; a bulk search's budget counts from when it starts running.
   * @default 'interactive'
   */
  lane?: SearchLane;
  /**
   * The page answers by this many milliseconds, partial if it must: after the call in the
   * interactive lane, after it starts in the bulk lane.
   * @default the index's `budgetMs`
   */
  budgetMs?: number;
  /** Stops the page; it answers what it settled. */
  signal?: AbortSignal;
}

/** A substructure or browse page. */
export interface KeyPage {
  /** The hits, by order key then id. */
  hits: KeyCursor[];
  /** Where the next page starts; undefined when the answer is complete. */
  next: KeyCursor | undefined;
  /** Whether the page stopped before filling or exhausting: an exact prefix all the same. */
  partial: boolean;
  /** Candidates left out because their verification was killed (the watchdog). */
  unverified: number;
  /** What the page read. */
  info: {
    slices: number;
    bands: number;
    candidates: number;
    verified: number;
    kills: number;
    version: number;
  };
}

/** What the index hands a page. */
export interface PageContext {
  pool: SearchPool;
  layout: Layout;
  defaultSets: string[] | null;
  budgetMs: number;
  firstSliceRows: number;
  similarityUnitWords: number;
  verify: { chunkMinMs: number; chunkFactor: number; singleMs: number };
  hung: (queryIdCode: string) => HungMemory;
  searchId: number;
}

/**
 * One substructure page (or a browse, with an empty query): results by the order key, then id.
 * @param context - The index's state.
 * @param queryIdCode - The query, '' to browse.
 * @param options - The page's options.
 * @param after - The cursor of the previous page.
 * @returns The page.
 */
export function keyPage(
  context: PageContext,
  queryIdCode: string,
  options: SearchOptions,
  after: KeyCursor | undefined,
): Promise<KeyPage> {
  const started = performance.now();
  const {
    layout,
    pool,
    defaultSets,
    budgetMs,
    firstSliceRows,
    verify,
    hung,
    searchId,
  } = context;
  const keys = readKeyBits(options.bits);
  const plan = substructurePlan(queryIdCode, layout.frequencies, keys);
  const sets = setExpression(layout, options, defaultSets);
  const bounds = readFilters(layout.layout, options.filters);
  const limit = pageLimit(options.limit);
  const budget = options.budgetMs ?? budgetMs;
  const lane = options.lane ?? 'interactive';
  if (sets === null) {
    return Promise.resolve(pageOf(layout.version, undefined, false));
  }
  // A page stopped before it ran continues from where it would have started.
  const start = { key: options.keyMin ?? -Infinity, id: -1 };
  const resume = after !== undefined && isAfter(after, start) ? after : start;
  const settle = () => pageOf(layout.version, resume, true);
  return pool.search(
    async () => {
      const deadline = (lane === 'bulk' ? performance.now() : started) + budget;
      const { counters, hits, reason, resume } = await walkPage(pool, {
        layout,
        plan,
        sets,
        restrictionAt: restrictionRank(layout, sets, plan),
        bounds,
        keyMin: options.keyMin ?? -Infinity,
        keyMax: options.keyMax ?? Infinity,
        limit,
        deadline,
        signal: options.signal,
        cursor: after ?? null,
        firstSliceRows,
        hung: hung(plan.browse ? '' : queryIdCode),
        searchId,
        verifyChunkMinMs: verify.chunkMinMs,
        verifyChunkFactor: verify.chunkFactor,
        verifySingleMs: verify.singleMs,
      });
      return {
        hits,
        next: reason === 'exhausted' ? undefined : resume,
        partial: reason !== 'full' && reason !== 'exhausted',
        unverified: counters.unverified,
        info: {
          slices: counters.slices,
          bands: counters.bands,
          candidates: counters.candidates,
          verified: counters.verified,
          kills: counters.kills,
          version: layout.version,
        },
      };
    },
    lane,
    { signal: options.signal, settle },
  );
}

/** The most hits one page answers. */
export const MAX_PAGE_LIMIT = 1_000_000;

/**
 * The hits a page asks for, checked before any worker sizes a buffer by it.
 * @param limit - The option given.
 * @returns It, 24 when not given.
 * @throws {Error} When it is not a whole number from 1 to MAX_PAGE_LIMIT.
 */
export function pageLimit(limit: number | undefined): number {
  const value = limit ?? 24;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new Error(
      `limit is a whole number from 1 to ${MAX_PAGE_LIMIT}, not ${String(limit)}`,
    );
  }
  return value;
}

function pageOf(
  version: number,
  next: KeyCursor | undefined,
  partial: boolean,
): KeyPage {
  return {
    hits: [],
    next,
    partial,
    unverified: 0,
    info: {
      slices: 0,
      bands: 0,
      candidates: 0,
      verified: 0,
      kills: 0,
      version,
    },
  };
}
