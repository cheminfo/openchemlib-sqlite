import type { ColumnLayout } from '../blocks.ts';

import type { IndexedBlock, PhaseReply } from './messages.ts';

/** A verification call the watchdog killed: which candidates it held. */
export interface KilledCall {
  at: number;
  count: number;
  rangeEnd: number;
  single: boolean;
  /** True when the phase was over by then. */
  late: boolean;
}

/** How a phase ended. */
export interface PhaseEnd {
  reason: 'done' | 'deadline' | 'abort';
  /** Verification calls still running when it ended. */
  pendingBatches: number;
}

/** The phase under way. */
export interface RunningPhase {
  gen: number;
  finished: boolean;
}

/** Options of a phase. */
export interface PhaseOptions {
  /** The search's deadline, a performance.now() time. */
  deadline: number;
  signal?: AbortSignal;
  /** Hears every reply of the phase; returns true when the phase is done. */
  onMessage: (reply: PhaseReply) => boolean;
  /** Hears every kill of a call of the phase; returns true when that kill completes it. */
  onKill?: (call: KilledCall, running: RunningPhase | null) => boolean;
}

/** Options of a pool. */
export interface SearchPoolOptions {
  threads: number;
  file: string;
  layout: ColumnLayout;
  columnsSql: string;
  blocks: IndexedBlock[];
  watchdogGraceMs: number;
  stopMarginMs: number;
}
