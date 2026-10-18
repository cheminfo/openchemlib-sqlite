import type { SQLInputValue } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import { isReply } from '../workerReplies.ts';

import type { ReaderRequest, StoredRow } from './readerWorker.ts';

const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(
  FROM_SOURCE ? 'readerWorker.ts' : 'readerWorker.js',
  import.meta.url,
);

/** A request of the pool, without its id. */
type Request = ReaderRequest extends infer R
  ? R extends ReaderRequest
    ? Omit<R, 'id'>
    : never
  : never;

interface Reader {
  worker: Worker;
  /** Requests under way, by id. */
  waiting: Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >;
}

/**
 * Worker threads, each with a read-only connection of its own to the store's file. They read the
 * stored molecules of a list of no-stereo hashes, and they read ahead the index pages a commit will
 * write, so that the thread that commits finds them in the operating system's cache. The reads
 * leave the caller's thread, and run in parallel, which a disk serving random reads answers faster
 * than one after the other.
 */
export class ReaderPool {
  readonly #readers: Reader[] = [];
  #next = 0;

  /**
   * Starts the readers.
   * @param file - The database file.
   * @param threads - How many readers, at least 1.
   */
  constructor(file: string, threads: number) {
    for (let i = 0; i < Math.max(1, Math.trunc(threads)); i++) {
      const reader: Reader = {
        worker: new Worker(WORKER_URL, { workerData: { file } }),
        waiting: new Map(),
      };
      reader.worker.unref();
      reader.worker.on('message', (reply: unknown) => {
        if (!isReply(reply, 'id')) return;
        const request = reader.waiting.get(reply.id as number);
        if (request === undefined) return;
        reader.waiting.delete(reply.id as number);
        if (reader.waiting.size === 0) reader.worker.unref();
        if (reply.error === undefined) {
          request.resolve(reply.result);
        } else {
          request.reject(new Error(reply.error as string));
        }
      });
      reader.worker.on('error', (error: Error) => {
        for (const request of reader.waiting.values()) request.reject(error);
        reader.waiting.clear();
      });
      this.#readers.push(reader);
    }
  }

  /**
   * The stored molecules carrying each hash, read by all the readers at once.
   * @param hashes - The no-stereo hashes.
   * @returns Per hash, its molecules' ids and canonical idCodes.
   */
  async sameNoStereo(hashes: readonly bigint[]): Promise<StoredRow[][]> {
    const parts = this.#split(hashes.length, (from, to) => ({
      kind: 'same' as const,
      hashes: BigInt64Array.from(hashes.slice(from, to)),
    }));
    const answers = (await Promise.all(parts)) as StoredRow[][][];
    return answers.flat();
  }

  /**
   * Seeks each hash in its index, so that the pages where the commit will write them are read.
   * @param noStereo - No-stereo hashes.
   * @param tautomer - Tautomer hashes, as many.
   * @returns Once read.
   */
  async touch(
    noStereo: readonly bigint[],
    tautomer: readonly bigint[],
  ): Promise<void> {
    await Promise.all(
      this.#split(noStereo.length, (from, to) => ({
        kind: 'touch' as const,
        noStereo: BigInt64Array.from(noStereo.slice(from, to)),
        tautomer: BigInt64Array.from(tautomer.slice(from, to)),
      })),
    );
  }

  /**
   * Runs a statement once per key and drops its rows, to read the pages it reads.
   * @param sql - A statement taking one parameter.
   * @param keys - Its parameters.
   * @returns Once read.
   */
  async read(sql: string, keys: readonly SQLInputValue[]): Promise<void> {
    await Promise.all(
      this.#split(keys.length, (from, to) => ({
        kind: 'read' as const,
        sql,
        keys: keys.slice(from, to),
      })),
    );
  }

  /**
   * Stops the readers.
   * @returns Once they are stopped.
   */
  async close(): Promise<void> {
    await Promise.all(this.#readers.map((reader) => reader.worker.terminate()));
    this.#readers.length = 0;
  }

  #split(
    length: number,
    request: (from: number, to: number) => Request,
  ): Array<Promise<unknown>> {
    if (length === 0) return [];
    const size = Math.ceil(length / this.#readers.length);
    const parts: Array<Promise<unknown>> = [];
    for (let from = 0; from < length; from += size) {
      parts.push(this.#send(request(from, Math.min(length, from + size))));
    }
    return parts;
  }

  #send(request: Request): Promise<unknown> {
    const reader = this.#readers[this.#next++ % this.#readers.length] as Reader;
    const id = this.#next;
    return new Promise((resolve, reject) => {
      reader.waiting.set(id, { resolve, reject });
      reader.worker.ref();
      reader.worker.postMessage({ ...request, id });
    });
  }
}
