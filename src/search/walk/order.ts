import { xGetSortOrder } from 'ml-spectra-processing';

/**
 * The order of (key, id) pairs, ascending by key then id, through two stable radix sorts: by id
 * first, then by key, so equal keys keep their id order.
 * @param key - The keys.
 * @param id - The ids.
 * @param n - How many pairs (a prefix of both arrays).
 * @returns The positions, in order.
 */
export function orderByKeyId(
  key: Float64Array,
  id: Float64Array,
  n: number,
): Uint32Array {
  if (n < 2) return Uint32Array.from({ length: n }, (_, i) => i);
  const byId = xGetSortOrder(id.subarray(0, n));
  const keyById = new Float64Array(n);
  for (let i = 0; i < n; i++) keyById[i] = key[byId[i] as number] as number;
  const byKey = xGetSortOrder(keyById);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = byId[byKey[i] as number] as number;
  return order;
}
