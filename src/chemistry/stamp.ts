import {
  getFragFpKeys,
  getFunctionKeyFragments,
  getMoleculeSizes,
  getScreenKeys,
  hashToHex,
  strongHash,
} from 'openchemlib-search-wasm';

import { FINGERPRINT_WORDS, FUNCTION_WORDS_AT } from './bits.ts';
import { MAX_TAUTOMERS, computeRecords } from './records.ts';
import { STAMP_MOLECULES } from './stampData.ts';
import { MOLECULE_WORDS, bandOfWeight } from './tile.ts';

/** The file format this version writes and reads. */
export const FORMAT = 'openchemlib-sqlite 6';

/**
 * What each part of a store is computed under, as this build computes it: a digest of outputs for
 * built-in molecules and, for a fingerprint, of its key list too. The keys catch a changed key that
 * no built-in molecule holds; the outputs catch OCL reading the same keys differently. A
 * store records the signatures it was written under, so a build knows which part it must recompute.
 */
export interface Signatures {
  /** The canonical idCode, the atom count, the band and both hashes, with the tautomer cap. */
  identity: string;
  /** OCL's FragFp keys, the built-in molecules' FragFp and their bit counts. */
  fragFp: string;
  /** The screen keys and the built-in molecules' screen. */
  screen: string;
  /** The function keys and the built-in molecules' function words, stored in the tiles. */
  functions: string;
  /** The hash of the canonical idCode: OCL's StrongHasher, on the built-in molecules. */
  idCodeHash: string;
}

/** The signatures a stamp is made of: everything a file stores. */
export type StampParts = Pick<
  Signatures,
  'identity' | 'fragFp' | 'screen' | 'functions' | 'idCodeHash'
>;

interface Built {
  signatures: Signatures;
  stamp: string;
}

let built: Promise<Built> | undefined;

/**
 * The signatures of this build, computed once per process.
 * @returns Them.
 */
export async function computeSignatures(): Promise<Signatures> {
  built ??= buildSignatures();
  const { signatures } = await built;
  return signatures;
}

/**
 * The stamp of this build: the format, then a digest of the identity, FragFp, screen, function-key
 * and idCode hash signatures, everything a file stores. A file written under another stamp is
 * refused.
 * @returns The stamp, computed once per process.
 */
export async function computeStamp(): Promise<string> {
  built ??= buildSignatures();
  const { stamp } = await built;
  return stamp;
}

/**
 * The stamp of what a file stores.
 * @param parts - The signatures of its molecules, tiles and idCode hashes; `''` for a part it lacks.
 * @returns The format, then a digest of the parts.
 */
export async function stampOf(parts: StampParts): Promise<string> {
  const { identity, fragFp, screen, functions, idCodeHash } = parts;
  return `${FORMAT}:${await digest([identity, fragFp, screen, functions, idCodeHash].join('\n'))}`;
}

/**
 * The signature of a fingerprint: a digest of its key list, then of what it gives for some
 * molecules.
 * @param keys - The keys in bit order, one line each.
 * @param outputs - One line per molecule.
 * @returns 16 hexadecimal digits.
 */
export function fingerprintSignature(
  keys: readonly string[],
  outputs: readonly string[],
): Promise<string> {
  return digest([...keys, '', ...outputs].join('\n'));
}

async function buildSignatures(): Promise<Built> {
  const identity = [FORMAT, `maxTautomers=${MAX_TAUTOMERS}`];
  const fragFp: string[] = [];
  const screen: string[] = [];
  const functions: string[] = [];
  const idCodeHashes = ['strongHash'];
  const records = computeRecords(STAMP_MOLECULES);
  const sizes = getMoleculeSizes([...STAMP_MOLECULES]);
  for (let i = 0; i < STAMP_MOLECULES.length; i++) {
    if (records.errors[i] !== null) {
      throw new Error(`stamp molecule ${i}: ${records.errors[i]}`);
    }
    // The tail places a new molecule with getMoleculeSizes: it must agree with the records.
    if (
      bandOfWeight(sizes.weights[i] as number) !== records.bands[i] ||
      sizes.atomCounts[i] !== records.atoms[i]
    ) {
      throw new Error(`stamp molecule ${i}: sizes and records disagree`);
    }
    const words = records.words.subarray(
      i * MOLECULE_WORDS,
      (i + 1) * MOLECULE_WORDS,
    );
    idCodeHashes.push(hashToHex(strongHash(records.idCodes[i] as string)));
    const noStereo = hashToHex(records.noStereoHashes[i] as bigint);
    const tautomer = hashToHex(records.tautomerHashes[i] as bigint);
    identity.push(
      [
        records.idCodes[i],
        records.atoms[i],
        records.bands[i],
        noStereo,
        tautomer,
        records.truncated[i],
      ].join('|'),
    );
    fragFp.push(
      `${hexWords(words.subarray(0, FINGERPRINT_WORDS))}|${records.bits[i]}`,
    );
    screen.push(hexWords(words.subarray(FINGERPRINT_WORDS, FUNCTION_WORDS_AT)));
    functions.push(hexWords(words.subarray(FUNCTION_WORDS_AT)));
  }
  const signatures: Signatures = {
    identity: await digest(identity.join('\n')),
    fragFp: await fingerprintSignature(getFragFpKeys(), fragFp),
    screen: await fingerprintSignature(getScreenKeys(), screen),
    functions: await fingerprintSignature(
      getFunctionKeyFragments().map((fragments) => fragments.join(' ')),
      functions,
    ),
    idCodeHash: await digest(idCodeHashes.join('\n')),
  };
  return { signatures, stamp: await stampOf(signatures) };
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  let hex = '';
  for (const byte of new Uint8Array(bytes).subarray(0, 8)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function hexWords(words: Int32Array): string {
  const out = new Array<string>(words.length);
  for (let i = 0; i < words.length; i++) {
    out[i] = ((words[i] as number) >>> 0).toString(16);
  }
  return out.join('.');
}
