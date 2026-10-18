/**
 * A step of an index's load, in the order the steps run: the saved index when there is one, else
 * the store's tables (then the index is saved), then the tail and the search workers.
 */
export type LoadStep =
  | 'snapshot'
  | 'plan'
  | 'cells'
  | 'tiles'
  | 'index'
  | 'columns'
  | 'zones'
  | 'sets'
  | 'frequencies'
  | 'save'
  | 'tail'
  | 'workers';

/** How far one step of an index's load got. */
export interface LoadProgress {
  /** The step. */
  step: LoadStep;
  /** Its tasks taken so far (MiB for `snapshot` and `save`), at most `total`. */
  done: number;
  /** Its tasks; 0 for a step that counts none. */
  total: number;
  /** Whether the step is over. */
  finished: boolean;
  /** Why the step did not do its work: a saved index refused, or one not saved. */
  note?: string;
}

/** Hears how far a load got. */
export type LoadProgressListener = (progress: LoadProgress) => void;

/** How often a step with tasks reports how many its readers took. */
const REPORT_MS = 200;

/**
 * Runs one step of the load and tells the listener: when it starts, every 200 ms how many of its
 * tasks the readers took from their shared counter, and when it is over.
 * @param listener - Hears the step.
 * @param step - The step.
 * @param work - The step itself.
 * @param tasks - Its task count and the counter its readers pull from; omitted for a step that
 * counts none.
 * @param tasks.total - The tasks.
 * @param tasks.counter - The Int32 the readers add one to for each task they take.
 * @returns What the step returned.
 */
export async function runStep<T>(
  listener: LoadProgressListener,
  step: LoadStep,
  work: () => T | Promise<T>,
  tasks?: { total: number; counter: SharedArrayBuffer },
): Promise<T> {
  const total = tasks?.total ?? 0;
  listener({ step, done: 0, total, finished: false });
  // Each reader adds one past the last task before it stops, hence the bound.
  const taken = tasks === undefined ? null : new Int32Array(tasks.counter);
  const timer =
    taken === null
      ? undefined
      : setInterval(() => {
          const done = Math.min(Atomics.load(taken, 0), total);
          listener({ step, done, total, finished: false });
        }, REPORT_MS);
  try {
    const result = await work();
    listener({ step, done: total, total, finished: true });
    return result;
  } finally {
    clearInterval(timer);
  }
}

/**
 * The listener of a load nobody watches.
 */
export function ignoreProgress(): void {
  // Nobody listens.
}
