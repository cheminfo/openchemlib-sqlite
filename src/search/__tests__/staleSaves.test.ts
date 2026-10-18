import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { removeStaleSaves, temporaryOf } from '../snapshot/staleSaves.ts';

test('the saves cut short are removed, those of running processes kept', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ocl-sqlite-stale-'));
  try {
    const snapshot = join(directory, 'index.snapshot');
    const files = {
      // No process has a pid above 2^22, on Linux or on macOS.
      dead: `${snapshot}.4194305.tmp`,
      own: temporaryOf(snapshot),
      running: `${snapshot}.${process.ppid}.tmp`,
      snapshot,
      unnumbered: `${snapshot}.tmp`,
      notPid: `${snapshot}.1e3.tmp`,
      otherSnapshot: join(directory, 'other.snapshot.4194305.tmp'),
    };
    for (const file of Object.values(files)) writeFileSync(file, 'x');

    await removeStaleSaves(snapshot);

    const kept = Object.entries(files)
      .filter(([, file]) => existsSync(file))
      .map(([name]) => name);

    expect(kept).toStrictEqual([
      'running',
      'snapshot',
      'unnumbered',
      'notPid',
      'otherSnapshot',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a snapshot in a folder that does not exist has nothing to remove', async () => {
  await expect(
    removeStaleSaves(join(tmpdir(), 'ocl-sqlite-absent', 'index.snapshot')),
  ).resolves.toBeUndefined();
});
