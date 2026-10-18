/* eslint-disable no-await-in-loop -- each page continues the previous one */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type * as WorkerThreads from 'node:worker_threads';

import * as OCL from 'openchemlib';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

import { MoleculeIndex } from '../search/MoleculeIndex.ts';
import type { SimilarityFingerprint } from '../search/fingerprint.ts';
import type { ScoreCursor } from '../search/walk/similarityPage.ts';
import { MoleculeStore } from '../store/MoleculeStore.ts';

import {
  APP_SQL,
  SPEC,
  addMolecules,
  readIdCodes,
  testThreads,
} from './testDatabase.ts';
import {
  readAll,
  readTruth,
  similarityTruth,
  substructureTruth,
} from './truth.ts';

// Every message a library worker posts reaches its parent after a message that is not the
// library's, as `node --watch` posts `{ 'watch:import': [...] }` from every worker thread; one
// more comes before anything else. The foreign messages rotate through shapes each pool must
// tell from its replies.
const noise = vi.hoisted(() => ({
  sent: 0,
  messages: [
    { 'watch:import': ['file:///app/src/index.ts'] },
    'a string',
    null,
    { id: -1, result: 'not a reply' },
    { phase: 'not a phase' },
    { type: 'not a type', gen: 1 },
  ] as unknown[],
}));

vi.mock('node:worker_threads', async (importOriginal) => {
  const original = await importOriginal<typeof WorkerThreads>();
  class NoisyWorker extends original.Worker {
    constructor(...args: ConstructorParameters<typeof original.Worker>) {
      super(...args);
      queueMicrotask(() => this.#foreign());
    }

    override emit(event: string | symbol, ...args: unknown[]): boolean {
      if (event === 'message') this.#foreign();
      return super.emit(event, ...args);
    }

    #foreign(): void {
      const message = noise.messages[noise.sent % noise.messages.length];
      noise.sent++;
      super.emit('message', message);
    }
  }
  return { ...original, Worker: NoisyWorker };
});

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();
const watchBefore = process.env.WATCH_REPORT_DEPENDENCIES;
let directory: string;
let file: string;
let db: DatabaseSync;
let store: MoleculeStore;

beforeAll(() => {
  // On Node 26 this also makes every worker post Node's own watch messages.
  process.env.WATCH_REPORT_DEPENDENCIES = '1';
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-foreign-'));
  file = join(directory, 'db.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
});

afterAll(async () => {
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
  if (watchBefore === undefined) delete process.env.WATCH_REPORT_DEPENDENCIES;
  else process.env.WATCH_REPORT_DEPENDENCIES = watchBefore;
});

test('messages that are not the library replies leave the store and the index answering exactly', async () => {
  const idCodes = readIdCodes();
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  await addMolecules(db, store, idCodes.slice(0, 300), { seed: 5 });
  const found = await store.find(idCodes.slice(0, 50));

  expect(found.filter((id) => id === undefined)).toStrictEqual([]);

  // Reopening recomputes a sample in the workers.
  const reopened = await MoleculeStore.open(db, {
    threads: testThreads(2),
    checkRows: 64,
  });
  await reopened.close();

  const index = await MoleculeIndex.open(file, SPEC, {
    threads: testThreads(2),
    readers: testThreads(2),
    blockRows: 512,
    pollMs: 3_600_000,
  });
  try {
    const benzene = smiles('c1ccccc1');
    let rows = readTruth(db);
    const { ids } = await readAll(index, benzene, { limit: 7 });

    expect(ids).toStrictEqual(substructureTruth(rows, benzene, {}));

    const browsed = await readAll(index, '', { limit: 50 });

    expect(browsed.ids).toStrictEqual(substructureTruth(rows, '', {}));

    for (const fingerprint of ['fragFp', 'screen', 'both'] as const) {
      await expect(
        similarHits(index, benzene, fingerprint),
      ).resolves.toStrictEqual(
        similarityTruth(rows, benzene, 0.5, {}, fingerprint),
      );
    }

    // The tail: a poll, its publish, and its counters.
    await addMolecules(db, store, idCodes.slice(300, 420), { seed: 6 });
    await index.poll();
    await index.waitForSeq(store.lastSeq());
    rows = readTruth(db);

    const afterTail = await readAll(index, benzene, { limit: 50 });
    const stats = await index.tailStats();

    expect(index.rowCount).toBe(store.count());
    expect(afterTail.ids).toStrictEqual(substructureTruth(rows, benzene, {}));
    expect(stats.rows).toBe(120);
    expect(index.errors).toStrictEqual([]);
  } finally {
    await index.close();
  }

  // Enough foreign messages reached every pool to matter.
  expect(noise.sent).toBeGreaterThan(100);
}, 120_000);

async function similarHits(
  index: MoleculeIndex,
  query: string,
  fingerprint: SimilarityFingerprint,
): Promise<Array<{ id: number; score: number }>> {
  const hits: Array<{ id: number; score: number }> = [];
  let after: ScoreCursor | undefined;
  for (;;) {
    const page = await index.similarity(query, {
      threshold: 0.5,
      fingerprint,
      limit: 7,
      after,
      budgetMs: 60_000,
    });
    hits.push(...page.hits);
    if (page.next === undefined) return hits;
    after = page.next;
  }
}
