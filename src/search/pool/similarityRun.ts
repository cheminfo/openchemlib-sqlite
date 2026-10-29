import type { MessagePort } from 'node:worker_threads';

import { SEQ_SPAN } from '../../chemistry/key.ts';
import type { BlockViews, ColumnLayout } from '../blocks.ts';
import type { SimilarityFingerprint } from '../fingerprint.ts';

import type { IndexedBlock, SimilarityPhase } from './messages.ts';
import type { ExactRow } from './rowFilter.ts';
import { rowFilter } from './rowFilter.ts';
import type { SetWords } from './setWords.ts';
import { setWords } from './setWords.ts';
import { similarityWords } from './similarityKernel.ts';
import type { SimilarityContext, SimilarityTally } from './similarityLane.ts';

/** What a phase run reads of its search worker. */
export interface WorkerParts {
  port: MessagePort;
  /** The pool's control word: the phase under way. */
  control: Int32Array;
  worker: number;
  layout: ColumnLayout;
  /** A block, and its views. */
  block: (b: number) => IndexedBlock;
  views: (b: number) => BlockViews;
  /** Reads a row's exact values. */
  exact: ExactRow;
}

/**
 * Scores the similarity units this worker takes, each one reported with its counts and its best
 * rows after the cursor; a unit is left, reported stopped, once the phase moved on.
 * @param m - The phase.
 * @param w - The worker.
 */
export function runSimilarity(m: SimilarityPhase, w: WorkerParts): void {
  const next = new Int32Array(m.counter);
  const sets = setWords(m.sets);
  let b = -1;
  let context: SimilarityContext | null = null;
  while (Atomics.load(w.control, 0) === m.gen) {
    const u = Atomics.add(next, 0, 1);
    if (u >= m.units.length / 2) break;
    const tally: SimilarityTally = {
      scored: 0,
      matched: 0,
      afterCount: 0,
      kept: 0,
      hasAfter: m.afterScore !== null,
      afterScore: m.afterScore ?? 0,
      afterId: m.afterId,
      topId: new Float64Array(m.limit),
      topScore: new Float64Array(m.limit),
    };
    let stopped = false;
    const e1 = m.units[2 * u + 1] as number;
    for (let e = m.units[2 * u] as number; e < e1;) {
      if (Atomics.load(w.control, 0) !== m.gen) {
        stopped = true;
        break;
      }
      if (m.entries[4 * e] !== b) {
        b = m.entries[4 * e] as number;
        context = similarityContext(m, b, sets, w);
      }
      let to = e + 1;
      while (to < e1 && m.entries[4 * to] === b) to++;
      similarityWords(context as SimilarityContext, m.entries, e, to, tally);
      e = to;
    }
    const top = new Float64Array(2 * tally.kept);
    for (let i = 0; i < tally.kept; i++) {
      top[2 * i] = tally.topId[i] as number;
      top[2 * i + 1] = tally.topScore[i] as number;
    }
    w.port.postMessage({
      type: 'sim',
      gen: m.gen,
      scored: tally.scored,
      matched: tally.matched,
      afterCount: tally.afterCount,
      top,
      stopped,
    });
  }
  w.port.postMessage({ type: 'idle', gen: m.gen, worker: w.worker });
}

function similarityContext(
  m: SimilarityPhase,
  b: number,
  sets: SetWords,
  w: WorkerParts,
): SimilarityContext {
  const view = w.views(b);
  const block = w.block(b);
  const filter = rowFilter(view, w.layout, m.bounds, w.exact);
  const keyMin = m.keyMin;
  const keyMax = m.keyMax;
  const key = view.key;
  return {
    planes: view.planes,
    poff: offsets(m.planes, view.W),
    sets,
    single: sets.single,
    koff: offsets(m.keyPlanes, view.W),
    keyFlip: m.keyFlips,
    aoff: offsets(m.anyPlanes, view.W),
    base: block.start >>> 5,
    kBase: block.atoms * SEQ_SPAN,
    seq: view.seq,
    bits: countsOf(view, m.fingerprint),
    bits2: m.fingerprint === 'both' ? view.screenBits : null,
    zoneMin: view.zones[m.fingerprint].min,
    zoneMax: view.zones[m.fingerprint].max,
    low: m.low,
    high: m.high,
    threshold: m.threshold,
    qBits: m.qBits,
    mMin: m.mMin,
    D: m.D,
    // In similarity the key bounds are plain filters.
    keep:
      keyMin === -Infinity && keyMax === Infinity
        ? filter
        : (row, id) => {
            const k = key[row] as number;
            return (
              k >= keyMin && k <= keyMax && (filter === null || filter(row, id))
            );
          },
  };
}

/**
 * Each row's bit count in a fingerprint; for `both`, its FragFp part, the screen being `bits2`.
 * @param view - The block's views.
 * @param fingerprint - The fingerprint scored.
 * @returns The counts.
 */
function countsOf(
  view: BlockViews,
  fingerprint: SimilarityFingerprint,
): Uint16Array {
  if (fingerprint === 'screen') return view.screenBits;
  if (fingerprint === 'functions') return view.functionBits;
  return view.fragFpBits;
}

/**
 * Where each plane starts in a block's planes.
 * @param planes - The plane numbers.
 * @param W - Words per plane.
 * @returns Their first words.
 */
export function offsets(planes: Int32Array, W: number): Int32Array {
  const out = new Int32Array(planes.length);
  for (let i = 0; i < planes.length; i++) out[i] = (planes[i] as number) * W;
  return out;
}
