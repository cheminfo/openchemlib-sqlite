import type { SimilarityFingerprint } from './fingerprint.ts';
import { checkFingerprint } from './fingerprint.ts';
import type { PageContext, SearchOptions } from './pages.ts';
import { pageLimit } from './pages.ts';
import { readFilters, restrictionOf, similarityPlan } from './query.ts';
import type { ScoreCursor } from './walk/similarityPage.ts';
import { similarityPage } from './walk/similarityPage.ts';

/** What a similarity search takes. */
export interface SimilarityOptions extends SearchOptions {
  /**
   * The Tanimoto coefficient a hit reaches, in (0, 1].
   * @default 0.8
   */
  threshold?: number;
  /**
   * The fingerprint scored: `'fragFp'` (OpenChemLib's 512 FragFp keys), `'screen'` (the 512
   * query-fragment keys) or `'both'` (all 1,024 bits).
   * @default 'fragFp'
   */
  fingerprint?: SimilarityFingerprint;
  /** The previous page's `next`; it must belong to the same fingerprint. */
  after?: ScoreCursor;
}

/** A similarity page. */
export interface ScorePage {
  /** The hits, by score descending then id. */
  hits: Array<{ id: number; score: number }>;
  /** Where the next page starts; undefined when the answer is complete. */
  next: ScoreCursor | undefined;
  /** The rows reaching the threshold; a lower bound when partial. */
  total: number;
  /** Whether the deadline came before every unit was read: the best of the units read. */
  partial: boolean;
  /** The fingerprint scored. */
  fingerprint: SimilarityFingerprint;
  /**
   * Why the page is empty although the search is valid, as a sentence the caller can show: the
   * query sets no bit of the fingerprint, so no molecule was scored. Undefined otherwise.
   */
  reason: string | undefined;
  /** What the page read. */
  info: {
    units: number;
    unitsDone: number;
    /**
     * Rows whose Tanimoto was computed in the fingerprint (inside the bit-count window and the
     * filters), over the units read whole: at least `total`, at most the rows of the window.
     */
    scored: number;
    version: number;
  };
}

const NO_BIT: Record<SimilarityFingerprint, string> = {
  fragFp:
    'The query sets no FragFp bit, so no molecule was scored. Choose the screen fingerprint, or both.',
  screen:
    'The query sets no screen bit, so no molecule was scored. Choose the FragFp fingerprint, or both.',
  both: 'The query sets no fingerprint bit, so no molecule was scored.',
};

/**
 * One ranked similarity page on the fingerprint asked for: results by score descending, then id.
 * @param context - The index's state.
 * @param idCode - The query molecule.
 * @param options - The threshold, the fingerprint, the page's options and the cursor.
 * @returns The page.
 * @throws {Error} When the cursor belongs to another fingerprint (a cursor without one is a
 * FragFp cursor).
 */
export async function scorePage(
  context: PageContext,
  idCode: string,
  options: SimilarityOptions,
): Promise<ScorePage> {
  const started = performance.now();
  const { layout, pool, defaultSets, budgetMs, similarityUnitWords } = context;
  const fingerprint = checkFingerprint(options.fingerprint ?? 'fragFp');
  const after = options.after;
  if (after !== undefined) {
    const made = after.fingerprint ?? 'fragFp';
    if (made !== fingerprint) {
      throw new Error(
        `this cursor belongs to the '${made}' fingerprint; the search scores '${fingerprint}': start it again without a cursor`,
      );
    }
  }
  const plan = similarityPlan(
    idCode,
    options.threshold ?? 0.8,
    fingerprint,
    layout.frequencies,
  );
  const info = { units: 0, unitsDone: 0, scored: 0, version: layout.version };
  if (plan.qBits === 0) {
    return {
      hits: [],
      next: undefined,
      total: 0,
      partial: false,
      fingerprint,
      reason: NO_BIT[fingerprint],
      info,
    };
  }
  const restriction = restrictionOf(layout, options.sets ?? defaultSets);
  const bounds = readFilters(layout.layout, options.filters);
  const limit = pageLimit(options.limit);
  const deadline = started + (options.budgetMs ?? budgetMs);
  return pool.search(async () => {
    const run = await similarityPage(pool, {
      layout,
      plan,
      restriction,
      bounds,
      keyMin: options.keyMin ?? -Infinity,
      keyMax: options.keyMax ?? Infinity,
      limit,
      deadline,
      signal: options.signal,
      cursor: after ?? null,
      unitWords: similarityUnitWords,
    });
    const complete = run.reason === 'exhausted';
    const last = run.top.at(-1);
    return {
      hits: run.top.map(([id, score]) => ({ id, score })),
      next:
        complete && last !== undefined && run.afterTotal > limit
          ? { score: last[1], id: last[0], fingerprint }
          : undefined,
      total: run.total,
      partial: !complete,
      fingerprint,
      reason: undefined,
      info: {
        ...info,
        units: run.units,
        unitsDone: run.unitsDone,
        scored: run.scored,
      },
    };
  });
}
