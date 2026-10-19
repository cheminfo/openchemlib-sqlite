import type { Signatures } from '../chemistry/stamp.ts';
import { FORMAT } from '../chemistry/stamp.ts';

import type { StoreMeta, StoredSignatures } from './schema.ts';

/** Why a file of a pre-release 6.0 build is refused: its tiles hold no function keys. */
export const PRE_RELEASE_FILE =
  'the file was written by a pre-release build of openchemlib-sqlite 6, whose tiles hold no function keys: commit its idCodes into a new file, or migrate its 5.x original again';

/** A fingerprint whose bits the tiles store. */
export type StoredFingerprint = 'fragFp' | 'screen' | 'functions';

/**
 * Whether a file was written by a pre-release 6.0 build: one that kept no signatures, or no
 * function-key signature, since its tiles held no function key.
 * @param meta - The file's `ocl_meta`.
 * @returns True for such a file.
 */
export function isPreRelease(meta: StoreMeta): boolean {
  return meta.signatures === null || meta.signatures.functions === '';
}

/**
 * Refuses a file this build cannot search or write: another format, a pre-release 6.0 file,
 * molecules computed under another identity, or fingerprints computed under other keys. Searching
 * it would screen stored fingerprints against query fingerprints computed differently, and miss
 * matches without any error. Each refusal says what to do.
 * @param meta - The file's `ocl_meta`.
 * @param stamp - The stamp of this build.
 * @param signatures - The signatures of this build.
 */
export function validateMeta(
  meta: StoreMeta,
  stamp: string,
  signatures: Signatures,
): void {
  refuseFormat(meta);
  const stored = meta.signatures;
  if (stored === null || isPreRelease(meta)) throw new Error(PRE_RELEASE_FILE);
  if (stored.identity !== signatures.identity) {
    throw new Error(
      'the file holds molecules canonized or hashed differently from this build: commit its idCodes into a new file',
    );
  }
  const stale = staleTiles(stored, signatures);
  if (stale.length > 0) {
    throw new Error(
      `the ${stale.join(' and ')} bits of the file were computed under other keys: run MoleculeStore.rebuild() with this build, while the build that wrote it keeps serving`,
    );
  }
  if (stored.idCodeHash !== signatures.idCodeHash) {
    throw new Error(
      'the file holds no idCode hashes, or hashes computed otherwise: run MoleculeStore.rebuild() with this build, while the build that wrote it keeps serving',
    );
  }
  if (meta.stamp !== stamp) {
    throw new Error(
      `the file was written under stamp ${meta.stamp}, this build computes ${stamp}: its fingerprints and hashes must be rebuilt`,
    );
  }
}

/**
 * The fingerprints a file's tiles hold under other keys than this build's.
 * @param stored - What the file was computed under.
 * @param signatures - This build's signatures.
 * @returns `fragFp`, `screen`, `functions`, some of them or none.
 */
export function staleTiles(
  stored: StoredSignatures,
  signatures: Signatures,
): StoredFingerprint[] {
  const stale: StoredFingerprint[] = [];
  if (stored.fragFp !== signatures.fragFp) stale.push('fragFp');
  if (stored.screen !== signatures.screen) stale.push('screen');
  if (stored.functions !== signatures.functions) stale.push('functions');
  return stale;
}

/**
 * Refuses a file an index cannot search with this build, by its stamp alone.
 * @param meta - The file's `ocl_meta`.
 * @param stamp - The stamp of this build.
 */
export function validateStamp(meta: StoreMeta, stamp: string): void {
  refuseFormat(meta);
  if (isPreRelease(meta)) throw new Error(PRE_RELEASE_FILE);
  if (meta.stamp !== stamp) {
    throw new Error(
      `the file was written under stamp ${meta.stamp}, this build computes ${stamp}: MoleculeStore.rebuild() must bring it to this build first`,
    );
  }
}

function refuseFormat(meta: StoreMeta): void {
  if (meta.format !== FORMAT) {
    throw new Error(
      `ocl_meta.format is "${meta.format}", this build reads "${FORMAT}": the file must be migrated`,
    );
  }
}
