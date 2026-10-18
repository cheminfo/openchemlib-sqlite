import type { Layout } from './layout.ts';
import type { SearchPool } from './pool/SearchPool.ts';
import type { FilterRange } from './query.ts';
import {
  readFilters,
  restrictionOf,
  restrictionRank,
  substructurePlan,
} from './query.ts';
import type { HungMemory } from './walk/verifySlice.ts';
import type { KeyCursor } from './walk/walkPage.ts';
import { walkPage } from './walk/walkPage.ts';

/** What every search takes. */
export interface SearchOptions {
  /**
   * Hits per page at most.
   * @default 24
   */
  limit?: number;
  /**
   * The sets the answer is restricted to (their union), e.g. `['listed']` or `['source:3']`; an
   * unknown name adds nothing.
   * @default the index's `defaultSets`
   */
  sets?: string[];
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
   * The page answers by this many milliseconds after the call, partial if it must.
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
  const plan = substructurePlan(queryIdCode, layout.frequencies);
  const restriction = restrictionOf(layout, options.sets ?? defaultSets);
  const bounds = readFilters(layout.layout, options.filters);
  const deadline = started + (options.budgetMs ?? budgetMs);
  const limit = pageLimit(options.limit);
  return pool.search(async () => {
    const { counters, hits, reason, resume } = await walkPage(pool, {
      layout,
      plan,
      restriction,
      restrictionAt: restrictionRank(layout, restriction, plan),
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
  });
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
