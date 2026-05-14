import { packSSIndex } from './packSSIndex.ts';

/**
 * Build SQL AND conditions that pre-filter rows whose ss_index bits are a
 * superset of the query bits — i.e. (stored & query) = query for each 64-bit
 * chunk. Returns a SQL fragment (ready to AND into a WHERE clause) and the
 * bound parameters. The s. alias refers to the ocl_ss_index table.
 * @param queryIndex - OCL fingerprint of the query molecule.
 * @returns SQL fragment and bound BigInt parameters for the prefilter.
 */
export function buildSSPrefilter(queryIndex: number[] | Uint32Array): {
  sql: string;
  params: bigint[];
} {
  const packed = packSSIndex(queryIndex);
  const sql: string[] = [];
  const params: bigint[] = [];
  for (let i = 0; i < 8; i++) {
    const val = packed[i] ?? 0n;
    sql.push(`(s.ss_index${i} & ?) = ?`);
    params.push(val, val);
  }
  return { sql: sql.join(' AND '), params };
}
