import { expect, test } from 'vitest';

import {
  FORMAT,
  computeSignatures,
  computeStamp,
  fingerprintSignature,
  stampOf,
} from '../stamp.ts';

test('the stamp and the signatures of this build are the ones the stores were written under', async () => {
  // A new value means openchemlib-search-wasm now computes something else: a new identity means
  // committing every molecule again, a new FragFp, screen or function signature rebuilding the
  // tiles.
  await expect(computeSignatures()).resolves.toStrictEqual({
    identity: 'b359e6bce51a2ca1',
    fragFp: '04e89d8cf33f1e07',
    screen: 'f560a4e05e7445bb',
    functions: '86de42bd0dd905bb',
    idCodeHash: '203ddab20d46c617',
  });
  await expect(computeStamp()).resolves.toBe(`${FORMAT}:5bef70280db479e3`);
});

test('the stamp is made of what a file stores: the function keys and the idCode hashes too', async () => {
  const signatures = await computeSignatures();

  await expect(stampOf(signatures)).resolves.toBe(await computeStamp());
  await expect(stampOf({ ...signatures, idCodeHash: '' })).resolves.toBe(
    `${FORMAT}:95ffb238b4764b88`,
  );
  await expect(
    stampOf({ ...signatures, functions: '0000000000000000' }),
  ).resolves.toBe(`${FORMAT}:67f6f88b1a7acfb1`);
});

test('a key no molecule holds still changes the signature of its fingerprint', async () => {
  const outputs = ['0.0.ff', '1.2.3'];
  const keys = ['fH@@', 'eF@Hp@'];
  const signature = await fingerprintSignature(keys, outputs);

  await expect(
    fingerprintSignature(['fH@@', 'eF@Hp`'], outputs),
  ).resolves.not.toBe(signature);
  await expect(
    fingerprintSignature(keys, ['0.0.ff', '1.2.4']),
  ).resolves.not.toBe(signature);
  await expect(fingerprintSignature(keys, outputs)).resolves.toBe(signature);
});
