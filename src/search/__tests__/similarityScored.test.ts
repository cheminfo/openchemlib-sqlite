/* eslint-disable no-await-in-loop -- each page continues the previous one */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  fingerprintOf,
  similarityTruth,
} from '../../__tests__/similarityTruth.ts';
import {
  APP_SQL,
  SPEC,
  addMolecules,
  readIdCodes,
  testThreads,
} from '../../__tests__/testDatabase.ts';
import type { TruthRow } from '../../__tests__/truth.ts';
import { passes, readTruth } from '../../__tests__/truth.ts';
import { countBits } from '../../chemistry/bits.ts';
import { MoleculeStore } from '../../store/MoleculeStore.ts';
import { MoleculeIndex } from '../MoleculeIndex.ts';
import type { SimilarityFingerprint } from '../fingerprint.ts';
import type { SearchOptions } from '../pages.ts';
import type { ScoreCursor } from '../walk/similarityPage.ts';

const FIXTURE = readIdCodes().slice(0, 400);
const SETS: Record<string, SearchOptions> = {
  none: {},
  'source B': { sets: ['source:2'] },
  'logP >= 2': { filters: { logP: { min: 2 } } },
  'key 250-400': { keyMin: 250, keyMax: 400 },
  'logP above every value': { filters: { logP: { min: 1e9 } } },
};

let directory: string;
let db: DatabaseSync;
let store: MoleculeStore;
let index: MoleculeIndex;
let rows: TruthRow[];

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-scored-'));
  db = new DatabaseSync(join(directory, 'db.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  for (const sql of APP_SQL) db.exec(sql);
  store = await MoleculeStore.open(db, { threads: testThreads(2) });
  await addMolecules(db, store, FIXTURE, { seed: 3 });
  rows = readTruth(db);
  index = await MoleculeIndex.open(join(directory, 'db.sqlite'), SPEC, {
    threads: testThreads(2),
    readers: testThreads(1),
    blockRows: 512,
    follow: false,
  });
}, 120_000);

afterAll(async () => {
  await index?.close();
  await store?.close();
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

test.each<SimilarityFingerprint>(['fragFp', 'screen', 'both', 'functions'])(
  'a similarity page on %s counts the rows it scored: at least those reaching the threshold, at most those of the bit-count window',
  async (fingerprint) => {
    const rowBits = bitCounts(
      rows.map((row) => row.idCode),
      fingerprint,
    );
    // Listed molecules, light to heavy: under the default set each reaches any threshold itself.
    const listed = rows.filter((row) => row.listed);
    const queries = [0, 0.5, 1].map(
      (at) => (listed[Math.floor(at * (listed.length - 1))] as TruthRow).idCode,
    );
    const failures: string[] = [];
    const emptyScored: number[] = [];
    let withHits = 0;
    for (const query of queries) {
      const [q] = bitCounts([query], fingerprint) as [number];
      for (const threshold of [0.5, 0.8]) {
        for (const [setName, options] of Object.entries(SETS)) {
          const reaching = similarityTruth(
            rows,
            query,
            threshold,
            options,
            fingerprint,
          );
          let window = 0;
          for (let i = 0; i < rows.length; i++) {
            const bits = rowBits[i] as number;
            if (
              bits >= threshold * q - 1e-9 &&
              bits <= q / threshold + 1e-9 &&
              passes(rows[i] as TruthRow, options)
            ) {
              window++;
            }
          }
          const pages = await readScored(
            query,
            threshold,
            options,
            fingerprint,
          );
          const scored = pages[0]?.scored ?? -1;
          const label = `${query}, ${setName}, t ${threshold}`;
          for (const page of pages) {
            // Every page reads every unit, so every page scores the same rows.
            if (page.partial || page.total !== reaching.length) {
              failures.push(`${label}: partial or total ${page.total}`);
            }
            if (page.scored !== scored) {
              failures.push(`${label}: scored ${page.scored} then ${scored}`);
            }
          }
          if (scored < reaching.length || scored > window) {
            failures.push(
              `${label}: ${reaching.length} <= ${scored} <= ${window} fails`,
            );
          }
          if (setName === 'logP above every value') emptyScored.push(scored);
          if (reaching.length > 0) withHits++;
        }
      }
    }

    expect(failures).toStrictEqual([]);
    expect(emptyScored).toStrictEqual([0, 0, 0, 0, 0, 0]);
    expect(withHits).toBeGreaterThanOrEqual(6);
  },
  120_000,
);

function bitCounts(
  idCodes: string[],
  fingerprint: SimilarityFingerprint,
): number[] {
  return fingerprintOf(idCodes, fingerprint).map((words) =>
    countBits(words, 0, words.length),
  );
}

async function readScored(
  query: string,
  threshold: number,
  options: SearchOptions,
  fingerprint: SimilarityFingerprint,
): Promise<Array<{ partial: boolean; total: number; scored: number }>> {
  const pages: Array<{ partial: boolean; total: number; scored: number }> = [];
  let after: ScoreCursor | undefined;
  for (;;) {
    const page = await index.similarity(query, {
      ...options,
      threshold,
      fingerprint,
      limit: 7,
      after,
      budgetMs: 60_000,
    });
    pages.push({
      partial: page.partial,
      total: page.total,
      scored: page.info.scored,
    });
    if (page.next === undefined) return pages;
    after = page.next;
  }
}
