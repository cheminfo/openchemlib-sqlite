import type { Block, ColumnLayout } from '../blocks.ts';
import type { SimilarityFingerprint } from '../fingerprint.ts';

import type { ColumnBound } from './rowFilter.ts';

/** Numbers per worker slot in the watch array: kill time, generation, first position, positions, range end, single. */
export const WATCH = 6;

/** A block as the workers' table holds it. */
export interface IndexedBlock extends Block {
  index: number;
}

/** What a search worker starts with. */
export interface SearchWorkerData {
  file: string;
  layout: ColumnLayout;
  columnsSql: string;
  control: SharedArrayBuffer;
  watch: SharedArrayBuffer;
  blocks: IndexedBlock[];
  worker: number;
}

/** Fields every phase message carries. */
export interface PhaseBase {
  gen: number;
  /** When the watchdog may kill a call of this phase (epoch ms). */
  killAt: number;
  /** The search's deadline (epoch ms). */
  deadlineAt: number;
  counter: SharedArrayBuffer;
}

/** Screen the units of a slice. */
export interface ScreenPhase extends PhaseBase {
  type: 'screen';
  entries: Float64Array;
  units: Int32Array;
  planes: Int32Array;
  restriction: SharedArrayBuffer;
  restrictionAt: number;
  lo: number;
  hi: number;
  end: number;
  cursorKey: number;
  cursorId: number;
  bounds: ColumnBound[];
}

/** Verify a slice's candidates, in (key, id) order. */
export interface VerifyPhase extends PhaseBase {
  type: 'verify';
  ids: SharedArrayBuffer;
  n: number;
  batches: Int32Array;
  state: SharedArrayBuffer;
  repair: SharedArrayBuffer;
  queryIdCode: string;
  searchId: number;
  chunkMinMs: number;
  chunkFactor: number;
  singleMs: number;
}

/** Score similarity units. */
export interface SimilarityPhase extends PhaseBase {
  type: 'sim';
  /** The fingerprint scored: which bit counts and zone map the window reads. */
  fingerprint: SimilarityFingerprint;
  entries: Float64Array;
  units: Int32Array;
  planes: Int32Array;
  restriction: SharedArrayBuffer;
  low: number;
  high: number;
  threshold: number;
  qBits: number;
  mMin: number;
  D: number;
  bounds: ColumnBound[];
  keyMin: number;
  keyMax: number;
  limit: number;
  afterScore: number | null;
  afterId: number;
}

/** A phase message. */
export type PhaseMessage = ScreenPhase | VerifyPhase | SimilarityPhase;

type WithoutTimes<M> = M extends PhaseMessage
  ? Omit<M, 'gen' | 'killAt' | 'deadlineAt'>
  : never;

/** A phase message as a walk writes it: the pool adds its generation and times. */
export type PhaseInput = WithoutTimes<PhaseMessage>;

/** A worker's reply that is not a phase's. */
export type ControlReply =
  | { type: 'idle'; worker: number; gen: number }
  | { type: 'ready'; worker: number };

/** What the screen of one worker found. */
export interface ScreenedReply {
  type: 'screened';
  gen: number;
  units: number;
  n: number;
  key: Float64Array;
  id: Float64Array;
}

/** One verification call's outcome. */
export interface VerifiedReply {
  type: 'verified';
  gen: number;
  batch: number;
  from: number;
  to: number;
  single: boolean;
  hits: number[];
  verified: number;
}

/** One similarity unit's outcome. */
export interface SimilarityReply {
  type: 'sim';
  gen: number;
  /** Rows whose Tanimoto was computed: inside the bit-count window and the filters. */
  scored: number;
  matched: number;
  afterCount: number;
  top: Float64Array;
  stopped: boolean;
}

/** A reply a phase hears. */
export type PhaseReply = ScreenedReply | VerifiedReply | SimilarityReply;
