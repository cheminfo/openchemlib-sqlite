import type { SearchLane } from '../pages.ts';

import type {
  IndexedBlock,
  PhaseInput,
  PhaseMessage,
  PhaseReply,
} from './messages.ts';
import type {
  KilledCall,
  PhaseEnd,
  PhaseOptions,
  RunningPhase,
  SearchPoolOptions,
} from './poolTypes.ts';
import type { QueuedAbort } from './searchLanes.ts';
import { SearchLanes } from './searchLanes.ts';
import type { Kill } from './workerSlots.ts';
import { WorkerSlots } from './workerSlots.ts';

/** How long a phase's kill handler outlives its kill time (late kills arrive after the phase). */
const KILL_HANDLER_KEEP_MS = 10_000;

interface Current extends RunningPhase {
  message: PhaseMessage;
  onReply: (reply: PhaseReply) => void;
  fail: (error: Error) => void;
}

interface KillHandler {
  expires: number;
  onKill: (call: KilledCall, running: RunningPhase | null) => void;
}

/**
 * The search workers. A search runs alone as a sequence of phases (screen a slice, verify its
 * candidates, score similarity units, count a key range); each phase has its own generation in a
 * shared control word, so a worker leaves a phase within a unit or a chunk once the coordinator
 * moved on. A phase ends when its handler says so, at the deadline, or on abort; nothing waits for
 * a call still running: its worker finishes it and takes the next phase. A call the watchdog kills
 * is reported to its phase, with the candidates it held.
 *
 * Searches wait in two lanes, so the site's own searches come first: when the workers free up,
 * the oldest interactive search runs before any bulk one, which agents, counts and exports use,
 * in short turns between them. A running search is never interrupted.
 */
export class SearchPool {
  readonly #options: SearchPoolOptions;
  readonly #slots: WorkerSlots;
  readonly #killHandlers = new Map<number, KillHandler>();
  #generation = 0;
  #current: Current | null = null;
  readonly #lanes = new SearchLanes(() => this.#failure);
  #failure: Error | null = null;
  /** Resolves once every worker is ready. */
  readonly ready: Promise<void>;

  /**
   * Starts the workers.
   * @param options - Threads, the file, the column layout and the blocks.
   */
  constructor(options: SearchPoolOptions) {
    this.#options = options;
    this.#slots = new WorkerSlots(options, {
      onReply: (reply) => {
        if (this.#current !== null && reply.gen === this.#current.gen) {
          this.#current.onReply(reply);
        }
      },
      onError: (error) => {
        this.#failure = error;
        this.#current?.fail(error);
      },
      onReady: (slot) => {
        const current = this.#current;
        if (current !== null && !current.finished) {
          this.#slots.post(slot, current.message);
        }
      },
      onKill: (kill) => this.#onKill(kill),
    });
    this.ready = this.#slots.ready;
  }

  /**
   * Runs one search alone, once the searches queued before it in its lane, and every interactive
   * one waiting when it is bulk, have run.
   * @param run - The search.
   * @param lane - The queue it waits in.
   * @param abort - Its signal, and what it answers when the signal aborts while it waits.
   * @returns What it answers.
   */
  search<T>(
    run: () => Promise<T>,
    lane: SearchLane = 'interactive',
    abort?: QueuedAbort<T>,
  ): Promise<T> {
    return this.#lanes.run(run, lane, abort);
  }

  /**
   * Blocks the tail published: every live worker adds them to its table.
   * @param added - The new blocks.
   */
  addBlocks(added: IndexedBlock[]): void {
    this.#slots.addBlocks(added);
  }

  /**
   * Posts the phase under way again to every live worker, so one that left it takes the work it
   * gained since (candidates to verify again after a kill).
   * @param gen - The phase.
   */
  wake(gen: number): void {
    const current = this.#current;
    if (current?.gen !== gen || current.finished) return;
    this.#slots.postAll(current.message);
  }

  /**
   * One phase of the search under way, posted to every live worker under a new generation.
   * @param message - The phase, without its generation and times.
   * @param options - Deadline, abort signal and handlers.
   * @returns How it ended.
   */
  phase(message: PhaseInput, options: PhaseOptions): Promise<PhaseEnd> {
    const { deadline, signal, onMessage, onKill } = options;
    const control = this.#slots.control;
    const gen = nextGeneration(this.#generation);
    this.#generation = gen;
    Atomics.store(control, 0, gen);
    const deadlineAt = performance.timeOrigin + deadline;
    const killAt = deadlineAt + this.#options.watchdogGraceMs;
    this.#dropExpiredHandlers();
    return new Promise((resolve, reject) => {
      // Set once the handlers exist: finish() clears it.
      const pending: { timer?: ReturnType<typeof setTimeout> } = {};
      const current: Current = {
        gen,
        finished: false,
        message: { ...message, gen, killAt, deadlineAt },
        onReply: (reply) => {
          if (!current.finished && onMessage(reply)) finish('done');
        },
        fail: (error) => {
          current.finished = true;
          if (this.#current === current) this.#current = null;
          reject(error);
        },
      };
      const onAbort = () => finish('abort');
      const finish = (reason: PhaseEnd['reason']) => {
        if (current.finished) return;
        current.finished = true;
        clearTimeout(pending.timer);
        signal?.removeEventListener('abort', onAbort);
        if (Atomics.load(control, 0) === gen) Atomics.store(control, 0, -gen);
        if (this.#current === current) this.#current = null;
        resolve({ reason, pendingBatches: this.#slots.runningCalls(gen) });
      };
      if (onKill !== undefined) {
        this.#killHandlers.set(gen, {
          expires: killAt + KILL_HANDLER_KEEP_MS,
          onKill: (call, running) => {
            if (onKill(call, running) && running !== null) finish('done');
          },
        });
      }
      this.#current = current;
      if (signal?.aborted) {
        finish('abort');
        return;
      }
      // A timer longer than 2^31 - 1 ms would fire at once.
      pending.timer = setTimeout(
        () => finish('deadline'),
        Math.min(
          2 ** 31 - 1,
          Math.max(
            0,
            deadline - this.#options.stopMarginMs - performance.now(),
          ),
        ),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#slots.postAll(current.message);
    });
  }

  /**
   * Stops the workers.
   * @returns Once they are stopped.
   */
  async close(): Promise<void> {
    Atomics.store(this.#slots.control, 0, -1);
    await this.#slots.close();
  }

  #onKill(kill: Kill): void {
    const handler = this.#killHandlers.get(kill.gen);
    if (handler === undefined) return;
    const current = this.#current;
    const running =
      current !== null && current.gen === kill.gen && !current.finished
        ? current
        : null;
    const { at, count, rangeEnd, single } = kill;
    handler.onKill(
      { at, count, rangeEnd, single, late: running === null },
      running,
    );
  }

  #dropExpiredHandlers(): void {
    const now = performance.timeOrigin + performance.now();
    for (const [gen, entry] of this.#killHandlers) {
      if (entry.expires < now) this.#killHandlers.delete(gen);
    }
  }
}

/**
 * The generation after one: the workers read it as an Int32, and a phase stops on its negation,
 * so it stays from 1 to 2^31 - 1, back to 1 after the last.
 * @param generation - The last one.
 * @returns The next one.
 */
export function nextGeneration(generation: number): number {
  return generation >= 2 ** 31 - 1 ? 1 : generation + 1;
}
