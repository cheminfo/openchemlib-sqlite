/* eslint-disable no-await-in-loop -- every query and option set is read in turn */
import type { DatabaseSync } from 'node:sqlite';

import * as OCL from 'openchemlib';
import { expect } from 'vitest';

import { countTruth } from '../../__tests__/countTruth.ts';
import { drawSearches, keyPopulations } from '../../__tests__/draws.ts';
import { similarityTruth } from '../../__tests__/similarityTruth.ts';
import type { TruthRow } from '../../__tests__/truth.ts';
import {
  readAll,
  readTruth,
  substructureTruth,
} from '../../__tests__/truth.ts';
import type { MoleculeIndex } from '../MoleculeIndex.ts';
import type { SearchOptions } from '../pages.ts';

const smiles = (text: string) => OCL.Molecule.fromSmiles(text).getIDCode();
const QUERIES = [
  '',
  smiles('c1ccccc1'),
  smiles('Oc1ccccc1'),
  smiles('ClCCCO'),
  'gOp@DjWkB@@Mi`',
];
const SETS: SearchOptions[] = [
  {},
  { sets: ['source:2'] },
  { sets: ['source:3'] },
  { sets: ['source:4'] },
  { keyMin: 150, keyMax: 300, filters: { logP: { min: 0 } } },
];

/**
 * Every query × set paged to the end through the index, against brute force over SQL; counts,
 * browses and counts with key bits (function keys among them), and similarity on every
 * fingerprint, whose bit-count windows the tail fills.
 * @param index - The index.
 * @param db - The database.
 * @param label - What the check follows.
 */
export async function expectExact(
  index: MoleculeIndex,
  db: DatabaseSync,
  label: string,
): Promise<void> {
  await index.poll();
  const rows = readTruth(db, { keys: true });
  for (const query of QUERIES) {
    for (const options of SETS) {
      const expected = substructureTruth(rows, query, options);
      const { ids } = await readAll(index, query, { ...options, limit: 1000 });

      expect(
        ids,
        `${label}: ${query || 'browse'} ${JSON.stringify(options)}`,
      ).toStrictEqual(expected);

      const tight = await readAll(index, query, {
        ...options,
        limit: 40,
        budgetMs: 2,
      });

      expect(tight.ids, `${label}, 2 ms pages`).toStrictEqual(expected);
    }
  }
  // The count reads the version's own bands: the ranges append areas moved away from are left.
  for (const options of [...SETS, ...keyedSearches(rows)]) {
    await expect(
      index.count(options),
      `${label}: count ${JSON.stringify(options)}`,
    ).resolves.toStrictEqual(countTruth(rows, options));
  }
  for (const options of keyedSearches(rows)) {
    const { ids } = await readAll(index, '', { ...options, limit: 1000 });

    expect(ids, `${label}: keys ${JSON.stringify(options)}`).toStrictEqual(
      substructureTruth(rows, '', options),
    );
  }
  const benzene = smiles('c1ccccc1');
  // The tail counts the screen and function bits of each row it appends: every fingerprint must agree.
  for (const fingerprint of [
    'fragFp',
    'screen',
    'both',
    'functions',
  ] as const) {
    const similar = await index.similarity(benzene, {
      threshold: 0.5,
      fingerprint,
      limit: 1000,
      budgetMs: 60_000,
    });

    expect(similar.hits, `${label}: similarity, ${fingerprint}`).toStrictEqual(
      similarityTruth(rows, benzene, 0.5, {}, fingerprint),
    );
  }
}

/**
 * Searches with key bits: three function keys held by 5 % to 50 % of the rows, and seeded draws
 * over every fingerprint.
 * @param rows - The truth, read with its keys.
 * @returns The searches' options.
 */
function keyedSearches(rows: TruthRow[]): SearchOptions[] {
  const populations = keyPopulations(rows);
  const common: number[] = [];
  for (let bit = 1024; bit < 1536 && common.length < 3; bit++) {
    const share = (populations[bit] as number) / rows.length;
    if (share >= 0.05 && share <= 0.5) common.push(bit);
  }
  const [a = 1024, b = 1025, c = 1026] = common;
  return [
    { bits: { all: [a] } },
    { sets: ['source:2'], bits: { none: [b] } },
    { noneSets: ['source:3'], bits: { any: [a, c], none: [16] } },
    ...drawSearches(rows, 21, 4),
  ];
}
