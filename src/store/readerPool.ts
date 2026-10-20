import type { SQLInputValue } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import { isReply } from '../workerReplies.ts';

import type { ReaderRequest } from './readerWorker.ts';

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
   * The stored molecule of each idCode, sought by the hash of that idCode, by all the readers at
   * once: one seek each, whatever the number of its stereoisomers.
   * @param hashes - The idCodes' hashes, `strongHash(idCode)`.
   * @param idCodes - The idCodes, as many: a hash two idCodes share is told apart by them.
   * @returns Per idCode, the id of the stored molecule, -1 for none.
   */
  async exact(
    hashes: readonly bigint[],
    idCodes: readonly string[],
  ): Promise<Float64Array> {
    const parts = this.#split(hashes.length, (from, to) => ({
      kind: 'exact' as const,
      hashes: BigInt64Array.from(hashes.slice(from, to)),
      idCodes: idCodes.slice(from, to),
    }));
    return joinParts(
      (await Promise.all(parts)) as Float64Array[],
      (length) => new Float64Array(length),
    );
  }

  /**
   * Whether a stored molecule carries each no-stereo hash, by all the readers at once.
   * @param hashes - The no-stereo hashes.
   * @returns Per hash, 1 when stored, else 0.
   */
  async families(hashes: readonly bigint[]): Promise<Uint8Array> {
    const parts = this.#split(hashes.length, (from, to) => ({
      kind: 'family' as const,
      hashes: BigInt64Array.from(hashes.slice(from, to)),
    }));
    return joinParts(
      (await Promise.all(parts)) as Uint8Array[],
      (length) => new Uint8Array(length),
    );
  }

  /**
   * Seeks each hash in its index, so that the pages where the commit will read and write them are
   * read.
   * @param noStereo - No-stereo hashes.
   * @param tautomer - Tautomer hashes, as many.
   * @param idCode - IdCode hashes, as many.
   * @returns Once read.
   */
  async touch(
    noStereo: readonly bigint[],
    tautomer: readonly bigint[],
    idCode: readonly bigint[],
  ): Promise<void> {
    await Promise.all(
      this.#split(noStereo.length, (from, to) => ({
        kind: 'touch' as const,
        noStereo: BigInt64Array.from(noStereo.slice(from, to)),
        tautomer: BigInt64Array.from(tautomer.slice(from, to)),
        idCode: BigInt64Array.from(idCode.slice(from, to)),
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

/**
 * The parts of an answer, joined in order.
 * @param parts - The readers' answers.
 * @param create - Makes the joined array, of a length.
 * @returns One array.
 */
function joinParts<T extends Float64Array | Uint8Array>(
  parts: readonly T[],
  create: (length: number) => T,
): T {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = create(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
