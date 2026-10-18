import { Worker } from 'node:worker_threads';

import { isReply } from '../../workerReplies.ts';
import type { Layout } from '../layout.ts';
import type { LoadedImage } from '../load/loadImage.ts';
import type { NormalizedSpec } from '../spec.ts';

import { nextLayout } from './nextLayout.ts';
import type {
  PublishMessage,
  TailCheckpoint,
  TailCounters,
  TailOptions,
} from './tailState.ts';
import { tailWorkerData } from './tailState.ts';

/** The `type` of every message the tail worker posts. */
const TAIL_MESSAGES: ReadonlySet<unknown> = new Set([
  'ready',
  'publish',
  'caughtUp',
  'error',
  'polled',
  'paused',
  'resumed',
  'stats',
  'closed',
]);

const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(
  FROM_SOURCE ? 'tailWorker.ts' : 'tailWorker.js',
  import.meta.url,
);

/**
 * Follows the file: a worker thread polls it, and every change it finds becomes a new immutable
 * version of the image (new records for the bands it changed, the new append blocks, the bitmaps).
 */
export class Tail {
  readonly #worker: Worker;
  readonly #requests = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  #next = 0;
  #waiters: Array<{ seq: number; resolve: () => void }> = [];
  #closed = false;
  /** Why the worker is gone, once it is: no request reaches it any more. */
  #dead: Error | null = null;
  readonly #onPublish: (layout: Layout, message: PublishMessage) => void;
  /** The current version. */
  current: Layout;
  /** Errors the tail met (a pruned change log, a failed poll). */
  readonly errors: string[] = [];
  /** Resolves once the worker runs. */
  readonly ready: Promise<void>;
  /** Hears what the tail took in so far, with each publish and when a catch-up ends. */
  onCounters: (counters: TailCounters) => void = noop;

  /**
   * Starts following a file.
   * @param file - The database.
   * @param image - The loaded image.
   * @param spec - The application's specification.
   * @param options - Polling and sizes.
   * @param onPublish - Called with each new version before it becomes current.
   */
  constructor(
    file: string,
    image: LoadedImage,
    spec: NormalizedSpec,
    options: TailOptions,
    onPublish: (layout: Layout, message: PublishMessage) => void,
  ) {
    this.#onPublish = onPublish;
    this.current = image.layout;
    const workerData = tailWorkerData(file, image, spec, options);
    this.#worker = new Worker(WORKER_URL, { workerData });
    let started: () => void = noop;
    let failed: (error: Error) => void = noop;
    this.ready = new Promise((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    this.#worker.on('message', (message: unknown) => {
      // Only the tail's messages: Node's watch mode posts messages of its own.
      if (!isReply(message, 'type', TAIL_MESSAGES)) return;
      if (message.type === 'ready') started();
      else this.#onMessage(message);
    });
    this.#worker.on('error', (error: Error) => {
      this.errors.push(String(error.stack ?? error));
      failed(error);
      this.#die(error);
    });
    this.#worker.on('exit', () => {
      if (!this.#closed) this.#die(new Error('the tail worker stopped'));
    });
  }

  /**
   * Polls now.
   * @returns Once the versions it publishes are current.
   */
  async poll(): Promise<void> {
    await this.#request('poll');
  }

  /**
   * Resolves once a published version holds every molecule up to a seq.
   * @param seq - The seq.
   * @param timeoutMs - Rejects after it.
   * @returns When it is visible.
   */
  waitForSeq(seq: number, timeoutMs = 60_000): Promise<void> {
    if (this.current.watermark >= seq) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { seq, resolve: () => undefined as void };
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((entry) => entry !== waiter);
        reject(new Error(`seq ${seq} not published within ${timeoutMs} ms`));
      }, timeoutMs);
      waiter.resolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.#waiters.push(waiter);
    });
  }

  /**
   * The tail's counters.
   * @returns Polls, rows and changes read, anomalies, errors, version, watermark.
   */
  async stats(): Promise<Record<string, unknown>> {
    const reply = await this.#request('stats');
    return reply.stats as Record<string, unknown>;
  }

  /**
   * Stops polling until `resume()`, once the poll running is published: the image then holds
   * still while a save reads it. Polls asked for meanwhile wait for the resume.
   * @returns Where the tail stands; `current` is the version it names.
   */
  async pause(): Promise<TailCheckpoint> {
    if (this.#closed) throw new Error('the tail is closed');
    const reply = await this.#request('pause');
    return reply.checkpoint as TailCheckpoint;
  }

  /** Polls again, the polls asked for while paused first. */
  async resume(): Promise<void> {
    await this.#request('resume');
  }

  /** Stops the worker. */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#dead === null) await this.#request('close');
    this.#closed = true;
    for (const waiter of this.#waiters) waiter.resolve();
    this.#waiters = [];
    await this.#worker.terminate();
  }

  /**
   * Notes the worker gone: a request waiting for it, or made from now on, would wait forever.
   * @param error - Why it is gone.
   */
  #die(error: Error): void {
    this.#dead ??= error;
    for (const request of this.#requests.values()) request.reject(error);
    this.#requests.clear();
  }

  #request(type: string): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.resolve({});
    if (this.#dead !== null) return Promise.reject(this.#dead);
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#requests.set(id, { resolve, reject });
      this.#worker.postMessage({ type, id });
    });
  }

  #onMessage(message: Record<string, unknown>): void {
    if (message.type === 'publish') {
      this.#publish(message as unknown as PublishMessage);
      return;
    }
    if (message.type === 'caughtUp') {
      this.onCounters(message.counters as TailCounters);
      return;
    }
    if (message.type === 'error') this.errors.push(String(message.error));
    const request =
      typeof message.id === 'number'
        ? this.#requests.get(message.id)
        : undefined;
    if (request === undefined) return;
    this.#requests.delete(message.id as number);
    if (message.type === 'error') {
      request.reject(new Error(`tail: ${String(message.error)}`));
    } else {
      request.resolve(message);
    }
  }

  #publish(message: PublishMessage): void {
    const layout = nextLayout(this.current, message);
    this.#onPublish(layout, message);
    this.current = layout;
    this.#waiters = this.#waiters.filter((waiter) => {
      if (layout.watermark < waiter.seq) return true;
      waiter.resolve();
      return false;
    });
    this.onCounters(message.counters);
  }
}

function noop(): void {
  // Replaced once the promise exists.
}
