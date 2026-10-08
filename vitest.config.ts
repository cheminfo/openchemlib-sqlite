import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      provider: 'v8',
    },
    snapshotFormat: {
      maxOutputLength: Number.MAX_SAFE_INTEGER,
    },
    // The first test of each file pays for loading OpenChemLib and its wasm
    // fingerprinter, already 3 s on a CI runner.
    testTimeout: 30_000,
  },
});
