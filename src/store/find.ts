import { NO_HASH, strongHash } from 'openchemlib-search-wasm';

import type { ChemistryPool } from './chemistryPool.ts';
import type { IdentityStatements } from './identity.ts';
import { holdsNoStereo, storedIdOf } from './identity.ts';
import type { ReaderPool } from './readerPool.ts';

/** What a lookup reads with, besides the chemistry workers. */
export interface FindContext {
  /** The connection's identity statements. */
  identity: IdentityStatements;
  /** Readers off the caller's thread, for the seeks. */
  readers?: ReaderPool;
}

/**
 * The ids of stored molecules, by idCode (canonical or not). Each idCode is first sought by its
 * own hash, which finds a canonical one in one seek. One not found can only be stored if its
 * compound is: its no-stereo hash, computed in the workers, is sought next, and only when a
 * stereoisomer is stored is its canonical idCode computed and sought in turn. A lookup never reads
 * the stored stereoisomers themselves, so its cost does not grow with their number. With readers,
 * the seeks leave the caller's thread.
 * @param pool - The chemistry workers.
 * @param idCodes - The molecules.
 * @param context - The connection and its statements, and the readers when the store has them.
 * @returns Per idCode, the id, or undefined when the store does not hold it.
 */
export async function findIds(
  pool: ChemistryPool,
  idCodes: readonly string[],
  context: FindContext,
): Promise<Array<number | undefined>> {
  const out = await exactIds(context, idCodes);
  const missing: number[] = [];
  for (let i = 0; i < idCodes.length; i++) {
    if (out[i] === undefined && idCodes[i] !== '') missing.push(i);
  }
  if (missing.length === 0) return out;

  const hashes = await pool.noStereo(missing.map((i) => idCodes[i] as string));
  const candidates: number[] = [];
  const keys: bigint[] = [];
  for (let j = 0; j < missing.length; j++) {
    const hash = hashes[j] as bigint;
    if (hash === NO_HASH) continue;
    candidates.push(missing[j] as number);
    keys.push(hash);
  }
  const families = await familiesStored(context, keys);
  const pending: number[] = [];
  for (let k = 0; k < candidates.length; k++) {
    if (families[k] === 1) pending.push(candidates[k] as number);
  }
  if (pending.length === 0) return out;

  // Rare: a stereoisomer is stored, or the idCode given is not canonical.
  const records = await pool.records(pending.map((i) => idCodes[i] as string));
  const canonical = await exactIds(
    context,
    records.idCodes,
    records.idCodeHashes,
  );
  for (let k = 0; k < pending.length; k++) {
    out[pending[k] as number] = canonical[k];
  }
  return out;
}

/**
 * The stored molecule of each idCode, sought by its hash.
 * @param context - The statements, and the readers when the store has them.
 * @param idCodes - The idCodes; an empty one is never stored.
 * @param hashes - Their hashes when already computed, else `strongHash` of each.
 * @returns Per idCode, the id, or undefined.
 */
async function exactIds(
  context: FindContext,
  idCodes: readonly string[],
  hashes?: BigInt64Array,
): Promise<Array<number | undefined>> {
  const out = new Array<number | undefined>(idCodes.length).fill(undefined);
  const asked: number[] = [];
  const keys: bigint[] = [];
  const codes: string[] = [];
  for (let i = 0; i < idCodes.length; i++) {
    const idCode = idCodes[i] as string;
    if (idCode === '') continue;
    asked.push(i);
    codes.push(idCode);
    keys.push(
      hashes === undefined ? strongHash(idCode) : (hashes[i] as bigint),
    );
  }
  const { identity, readers } = context;
  if (readers === undefined) {
    for (let k = 0; k < asked.length; k++) {
      out[asked[k] as number] = storedIdOf(
        identity,
        keys[k] as bigint,
        codes[k] as string,
      );
    }
    return out;
  }
  const ids = await readers.exact(keys, codes);
  for (let k = 0; k < asked.length; k++) {
    const id = ids[k] as number;
    if (id >= 0) out[asked[k] as number] = id;
  }
  return out;
}

/**
 * Whether a stored molecule holds each no-stereo hash.
 * @param context - The statements, and the readers when the store has them.
 * @param hashes - The no-stereo hashes.
 * @returns Per hash, 1 when one does, else 0.
 */
async function familiesStored(
  context: FindContext,
  hashes: readonly bigint[],
): Promise<Uint8Array> {
  const { identity, readers } = context;
  if (readers !== undefined) return readers.families(hashes);
  const stored = new Uint8Array(hashes.length);
  for (let k = 0; k < hashes.length; k++) {
    stored[k] = holdsNoStereo(identity, hashes[k] as bigint) ? 1 : 0;
  }
  return stored;
}
