import { Worker } from 'node:worker_threads';

import type {
  FingerprintColumns,
  FingerprintNeed,
  RecordColumns,
} from '../chemistry/records.ts';
import { isReply } from '../workerReplies.ts';

import type { ChemistryRequest, IdentityColumns } from './chemistryWorker.ts';

// From the published package the worker is the sibling `.js` file; from source (tests, benchmarks)
// it is the `.ts` one, which Node strips of its types itself.
const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_URL = new URL(
  FROM_SOURCE ? 'chemistryWorker.ts' : 'chemistryWorker.js',
  import.meta.url,
);

/** Molecules per job at most: a batch is cut so that every worker gets a share. */
const MAX_CHUNK = 256;

interface Job {
  request: Omit<ChemistryRequest, 'id'>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  /** The id the job was posted with: its reply carries it. */
  id: number;
}

/**
 * Worker threads that compute, through openchemlib-search-wasm, what the library stores about a
 * molecule (`prepare()`), and the identity hashes the lookups need. Started on the first
 * job, so a store that only reads never spawns one.
 */
export class ChemistryPool {
  readonly #threads: number;
  readonly #slots: Slot[] = [];
  readonly #queue: Job[] = [];
  #next = 0;
  #closed = false;

  /**
   * A pool of at most `threads` workers.
   * @param threads - Worker threads, at least 1.
   */
  constructor(threads: number) {
    this.#threads = Math.max(1, Math.trunc(threads));
  }

  /**
   * Everything the library stores about each molecule.
   * @param idCodes - The molecules.
   * @returns The values, column by column, in input order.
   */
  async records(idCodes: readonly string[]): Promise<RecordColumns> {
    const parts = await this.#split<RecordColumns>('records', idCodes);
    return concatRecords(parts);
  }

  /**
   * Some fingerprints of each molecule, with the cheapest call that gives them.
   * @param idCodes - The molecules.
   * @param need - Which fingerprints.
   * @returns 16 words per molecule of each one asked for, in input order.
   */
  async fingerprints(
    idCodes: readonly string[],
    need: FingerprintNeed,
  ): Promise<FingerprintColumns> {
    const parts = await this.#split<FingerprintColumns>(
      'fingerprints',
      idCodes,
      need,
    );
    const join = (pick: (part: FingerprintColumns) => Int32Array | null) =>
      concatTyped(
        Int32Array,
        parts.map((part) => pick(part) as Int32Array),
      );
    return {
      fragFp: need.fragFp ? join((part) => part.fragFp) : null,
      screen: need.screen ? join((part) => part.screen) : null,
      functions: need.functions ? join((part) => part.functions) : null,
    };
  }

  /**
   * Both identity hashes of each molecule.
   * @param idCodes - The molecules.
   * @returns The hashes, in input order.
   */
  async identity(idCodes: readonly string[]): Promise<IdentityColumns> {
    const parts = await this.#split<IdentityColumns>('identity', idCodes);
    return {
      noStereoHashes: concatBig(parts.map((part) => part.noStereoHashes)),
      tautomerHashes: concatBig(parts.map((part) => part.tautomerHashes)),
    };
  }

  /**
   * The no-stereo hash of each molecule.
   * @param idCodes - The molecules.
   * @returns The hashes, in input order, NO_HASH where a molecule cannot be read.
   */
  async noStereo(idCodes: readonly string[]): Promise<BigInt64Array> {
    return concatBig(await this.#split<BigInt64Array>('noStereo', idCodes));
  }

  /** Terminates the workers; later jobs are refused. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#queue.splice(0)) {
      job.reject(new Error('the store is closed'));
    }
    await Promise.all(this.#slots.map((slot) => slot.worker.terminate()));
    this.#slots.length = 0;
  }

  #split<T>(
    type: ChemistryRequest['type'],
    idCodes: readonly string[],
    need?: FingerprintNeed,
  ): Promise<T[]> {
    if (idCodes.length === 0) return Promise.resolve([]);
    const size = Math.min(MAX_CHUNK, Math.ceil(idCodes.length / this.#threads));
    const jobs: Array<Promise<T>> = [];
    for (let from = 0; from < idCodes.length; from += size) {
      const chunk = idCodes.slice(from, from + size);
      jobs.push(this.#run({ type, idCodes: chunk, need }) as Promise<T>);
    }
    return Promise.all(jobs);
  }

  #run(request: Omit<ChemistryRequest, 'id'>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error('the store is closed'));
    return new Promise((resolve, reject) => {
      this.#queue.push({ request, resolve, reject });
      this.#dispatch();
    });
  }

  #dispatch(): void {
    while (this.#queue.length > 0) {
      let slot = this.#slots.find((candidate) => candidate.job === null);
      if (slot === undefined && this.#slots.length < this.#threads) {
        slot = this.#spawn();
      }
      if (slot === undefined) return;
      const job = this.#queue.shift() as Job;
      slot.job = job;
      // A worker keeps the process alive while it computes, never while it waits.
      slot.worker.ref();
      slot.id = ++this.#next;
      slot.worker.postMessage({ ...job.request, id: slot.id });
    }
  }

  #spawn(): Slot {
    const slot: Slot = { worker: new Worker(WORKER_URL), job: null, id: 0 };
    slot.worker.unref();
    slot.worker.on('message', (reply: unknown) => {
      // Only the reply to the job under way: Node's watch mode posts messages of its own.
      if (!isReply(reply, 'id') || reply.id !== slot.id || slot.job === null) {
        return;
      }
      const job = slot.job;
      slot.job = null;
      slot.worker.unref();
      if (reply.error === undefined) job.resolve(reply.result);
      else job.reject(new Error(reply.error as string));
      this.#dispatch();
    });
    slot.worker.on('error', (error: Error) => {
      const job = slot.job;
      slot.job = null;
      this.#slots.splice(this.#slots.indexOf(slot), 1);
      job?.reject(error);
      this.#dispatch();
    });
    this.#slots.push(slot);
    return slot;
  }
}

/**
 * Record columns of consecutive chunks joined into one.
 * @param parts - The chunks, in order.
 * @returns The columns of all of them.
 */
export function concatRecords(parts: RecordColumns[]): RecordColumns {
  return {
    idCodes: parts.flatMap((part) => part.idCodes),
    errors: parts.flatMap((part) => part.errors),
    atoms: concatTyped(
      Int32Array,
      parts.map((part) => part.atoms),
    ),
    bands: concatTyped(
      Int32Array,
      parts.map((part) => part.bands),
    ),
    bits: concatTyped(
      Int32Array,
      parts.map((part) => part.bits),
    ),
    words: concatTyped(
      Int32Array,
      parts.map((part) => part.words),
    ),
    idCodeHashes: concatBig(parts.map((part) => part.idCodeHashes)),
    noStereoHashes: concatBig(parts.map((part) => part.noStereoHashes)),
    tautomerHashes: concatBig(parts.map((part) => part.tautomerHashes)),
    truncated: concatTyped(
      Uint8Array,
      parts.map((part) => part.truncated),
    ),
  };
}

function concatTyped<T extends Int32Array | Float64Array | Uint8Array>(
  Type: new (length: number) => T,
  parts: T[],
): T {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Type(length);
  let at = 0;
  for (const part of parts) {
    (out as unknown as { set: (array: T, offset: number) => void }).set(
      part,
      at,
    );
    at += part.length;
  }
  return out;
}

function concatBig(parts: BigInt64Array[]): BigInt64Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new BigInt64Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
