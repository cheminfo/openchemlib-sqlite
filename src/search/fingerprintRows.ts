import type { Block } from './blocks.ts';
import type { SimilarityFingerprint } from './fingerprint.ts';
import { checkFingerprint } from './fingerprint.ts';
import type { Layout } from './layout.ts';

/**
 * Molecules read between two turns of the event loop: about 2 ms of plane reads for a FragFp, so a
 * request for 100,000 never holds the loop longer than a search's own bookkeeping.
 */
const ROWS_PER_TURN = 4096;

/**
 * One of the three sets of 512 keys the index keeps for every molecule: `'fragFp'`, OCL's FragFp;
 * `'screen'`, the query-fragment keys of the screen; `'functions'`, the function keys.
 */
export type KeySet = 'fragFp' | 'screen' | 'functions';

/** The key sets, in the order a molecule's 48 words keep them (16 words each). */
const KEY_SETS: readonly KeySet[] = ['fragFp', 'screen', 'functions'];

/** What `fingerprints()` reads. */
export interface FingerprintOptions {
  /**
   * The keys read: a similarity fingerprint (`'fragFp'`, `'screen'`, `'functions'`, or `'both'`
   * for the FragFp then the screen), or any key sets in the order wanted, e.g.
   * `['fragFp', 'functions']`. 16 words per key set.
   * @default 'fragFp'
   */
  fingerprint?: SimilarityFingerprint | readonly KeySet[];
  /**
   * Stops the reading between two turns; the promise then rejects with the signal's reason.
   * @default undefined
   */
  signal?: AbortSignal;
}

/** The fingerprints of molecules, read from the index. */
export interface Fingerprints {
  /** The key sets read, in the order their words come. */
  keySets: KeySet[];
  /** 32-bit words per molecule: 16 per key set. */
  width: number;
  /**
   * The words, `width` per id in the order asked, each key set's 16 as `getMoleculeRecords` writes
   * them (bit k of its word w is its key 32·w + k, least significant bit first); zeros for an id not
   * found.
   */
  words: Int32Array;
  /**
   * 1 for each id a search may answer (its row is alive), 0 for one it may not: unknown, removed,
   * left out by the columns SQL, or not followed yet.
   */
  found: Uint8Array;
}

/**
 * Reads the fingerprints of molecules from the bit planes of a version of the image, so nothing is
 * computed again from an idCode. The rows are read block by block in row order, every plane of a
 * fingerprint in turn over all the rows asked in its block, so each pass walks memory forward; a
 * turn of the event loop is given back every {@link ROWS_PER_TURN} molecules.
 * @param layout - The version read.
 * @param ids - The molecules, by id; one may be asked twice.
 * @param options - The fingerprint and the signal.
 * @returns Their words, and which were found.
 */
export async function readFingerprints(
  layout: Layout,
  ids: readonly number[],
  options: FingerprintOptions = {},
): Promise<Fingerprints> {
  const keySets = resolveKeySets(options.fingerprint ?? 'fragFp');
  const { signal } = options;
  signal?.throwIfAborted();
  const width = 16 * keySets.length;
  const sources = new Int32Array(width);
  for (const [position, keySet] of keySets.entries()) {
    const base = 16 * KEY_SETS.indexOf(keySet);
    for (let word = 0; word < 16; word++) {
      sources[16 * position + word] = base + word;
    }
  }
  const words = new Int32Array(ids.length * width);
  const found = new Uint8Array(ids.length);

  const rows = new Int32Array(ids.length);
  const alive = new Int32Array(layout.alive);
  const located: number[] = [];
  for (let position = 0; position < ids.length; position++) {
    const row = layout.rowOfId(ids[position] as number);
    if (row < 0 || (((alive[row >>> 5] as number) >>> (row & 31)) & 1) === 0) {
      continue;
    }
    rows[position] = row;
    found[position] = 1;
    located.push(position);
  }
  located.sort((a, b) => (rows[a] as number) - (rows[b] as number));

  for (let from = 0; from < located.length;) {
    if (from > 0) {
      // eslint-disable-next-line no-await-in-loop -- one turn after the other, so the loop is never held long
      await nextTurn();
      signal?.throwIfAborted();
    }
    const turnEnd = Math.min(located.length, from + ROWS_PER_TURN);
    while (from < turnEnd) {
      const block = layout.blockOfRow(rows[located[from] as number] as number);
      const { start, capacity } = layout.blocks[block] as Block;
      let to = from + 1;
      while (
        to < turnEnd &&
        (rows[located[to] as number] as number) < start + capacity
      ) {
        to++;
      }
      readBlock(layout, block, located, rows, from, to, sources, words);
      from = to;
    }
  }
  return { keySets, width, words, found };
}

/**
 * The key sets a `fingerprint` option names.
 * @param fingerprint - A similarity fingerprint, or key sets.
 * @returns The key sets, in order.
 * @throws {Error} When it names none, an unknown one, or one twice.
 */
function resolveKeySets(
  fingerprint: SimilarityFingerprint | readonly KeySet[],
): KeySet[] {
  if (!Array.isArray(fingerprint)) {
    const name = checkFingerprint(fingerprint);
    return name === 'both' ? ['fragFp', 'screen'] : [name];
  }
  const keySets = fingerprint as readonly unknown[];
  if (keySets.length === 0) {
    throw new Error('the key sets read are at least one');
  }
  for (const [position, keySet] of keySets.entries()) {
    if (!KEY_SETS.includes(keySet as KeySet)) {
      throw new Error(
        `a key set is 'fragFp', 'screen' or 'functions', not ${JSON.stringify(keySet)}`,
      );
    }
    if (keySets.indexOf(keySet) !== position) {
      throw new Error(`the key set '${keySet as KeySet}' is asked twice`);
    }
  }
  return [...(keySets as readonly KeySet[])];
}

/**
 * Reads the words of molecules that lie in one block, plane by plane.
 * @param layout - The version read.
 * @param block - The block.
 * @param located - The positions of the molecules asked, sorted by row.
 * @param rows - The row of each position.
 * @param from - The first of `located` in the block.
 * @param to - One past the last.
 * @param sources - For each word read, the word of a molecule's 48 it is.
 * @param words - Where each molecule's words go, by its position.
 */
function readBlock(
  layout: Layout,
  block: number,
  located: readonly number[],
  rows: Int32Array,
  from: number,
  to: number,
  sources: Int32Array,
  words: Int32Array,
): void {
  const { planes, W } = layout.views(block);
  const { start } = layout.blocks[block] as Block;
  const count = to - from;
  const width = sources.length;
  const wordOf = new Int32Array(count);
  const bitOf = new Int32Array(count);
  for (let entry = 0; entry < count; entry++) {
    const row = (rows[located[from + entry] as number] as number) - start;
    wordOf[entry] = row >>> 5;
    bitOf[entry] = row & 31;
  }
  const read = new Int32Array(count * width);
  for (let word = 0; word < width; word++) {
    const firstPlane = 32 * (sources[word] as number);
    for (let bit = 0; bit < 32; bit++) {
      const base = (firstPlane + bit) * W;
      const mask = 1 << bit;
      for (let entry = 0; entry < count; entry++) {
        const value = planes[base + (wordOf[entry] as number)] as number;
        if (((value >>> (bitOf[entry] as number)) & 1) !== 0) {
          const at = entry * width + word;
          read[at] = (read[at] as number) | mask;
        }
      }
    }
  }
  for (let entry = 0; entry < count; entry++) {
    words.set(
      read.subarray(entry * width, (entry + 1) * width),
      (located[from + entry] as number) * width,
    );
  }
}

/**
 * Gives a turn back to the event loop.
 * @returns Once the loop has run what was waiting.
 */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
