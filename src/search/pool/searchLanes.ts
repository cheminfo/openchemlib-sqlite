import type { SearchLane } from '../pages.ts';

/** How a search waiting in its lane ends when its signal aborts first. */
export interface QueuedAbort<T> {
  signal: AbortSignal | undefined;
  /** What the search answers when it never ran. */
  settle: () => T;
}

interface Queued {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  /** Stops listening to the signal: the search left its lane. */
  leave: () => void;
}

/**
 * Searches run one at a time from two queues: when the one running ends, the oldest interactive
 * search runs before any bulk one. A running search is never interrupted; one whose signal aborts
 * while it waits leaves its lane at once.
 */
export class SearchLanes {
  readonly #lanes: Record<SearchLane, Queued[]> = { interactive: [], bulk: [] };
  readonly #failure: () => Error | null;
  #running = false;

  /**
   * Empty queues.
   * @param failure - Why the workers failed, null while they run: a search starting then rejects.
   */
  constructor(failure: () => Error | null) {
    this.#failure = failure;
  }

  /**
   * Runs a search once those queued before it in its lane, and every interactive one waiting when
   * it is bulk, have run.
   * @param run - The search.
   * @param lane - The queue it waits in.
   * @param abort - Its signal, and what it answers when the signal aborts while it waits.
   * @returns What it answers.
   */
  run<T>(
    run: () => Promise<T>,
    lane: SearchLane,
    abort?: QueuedAbort<T>,
  ): Promise<T> {
    const signal = abort?.signal;
    if (signal?.aborted && this.#running && abort !== undefined) {
      return Promise.resolve(abort.settle());
    }
    return new Promise<T>((resolve, reject) => {
      const queue = this.#lanes[lane];
      const onAbort = () => {
        const at = queue.indexOf(queued);
        if (at === -1) return;
        queue.splice(at, 1);
        resolve((abort as QueuedAbort<T>).settle());
      };
      const queued: Queued = {
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
        leave: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(queued);
      this.#next();
    });
  }

  #next(): void {
    if (this.#running) return;
    const queued = this.#lanes.interactive.shift() ?? this.#lanes.bulk.shift();
    if (queued === undefined) return;
    queued.leave();
    this.#running = true;
    const failure = this.#failure();
    const result =
      failure === null
        ? Promise.resolve().then(queued.run)
        : Promise.reject(failure);
    void result.then(queued.resolve, queued.reject).finally(() => {
      this.#running = false;
      this.#next();
    });
  }
}
