import type { SimilarityFingerprint } from './fingerprint.ts';
import { FINGERPRINTS } from './fingerprint.ts';

/** Bytes per plane word of a block's zone maps: a Uint16 least and largest count per fingerprint. */
export const ZONE_BYTES = 4 * FINGERPRINTS.length;

/** Per plane word, the least and the largest bit count of its rows; an empty word holds 0xffff, 0. */
export interface Zone {
  min: Uint16Array;
  max: Uint16Array;
}

/**
 * The zone maps of a block, one per fingerprint, at the end of its columns buffer.
 * @param columns - The block's columns buffer.
 * @param at - The byte where the zone maps start.
 * @param W - Words per plane.
 * @returns The zone of each fingerprint.
 */
export function zoneViews(
  columns: SharedArrayBuffer,
  at: number,
  W: number,
): Record<SimilarityFingerprint, Zone> {
  const zone = (k: number): Zone => ({
    min: new Uint16Array(columns, at + 4 * k * W, W),
    max: new Uint16Array(columns, at + (4 * k + 2) * W, W),
  });
  return { fragFp: zone(0), screen: zone(1), both: zone(2) };
}

/**
 * Marks every word of the zone maps empty.
 * @param zones - The zone maps.
 */
export function emptyZones(zones: Record<SimilarityFingerprint, Zone>): void {
  for (const fingerprint of FINGERPRINTS) {
    zones[fingerprint].min.fill(0xffff);
    zones[fingerprint].max.fill(0);
  }
}

/**
 * Widens the zones of a row's word to its bit counts.
 * @param zones - The block's zone maps.
 * @param w - The word.
 * @param fragFp - The row's FragFp bit count.
 * @param screen - Its screen bit count.
 */
export function widenZones(
  zones: Record<SimilarityFingerprint, Zone>,
  w: number,
  fragFp: number,
  screen: number,
): void {
  widen(zones.fragFp, w, fragFp);
  widen(zones.screen, w, screen);
  widen(zones.both, w, fragFp + screen);
}

/**
 * Copies the zone words [from, from + words) of one block's maps to `to` of another's.
 * @param source - The zone maps read.
 * @param target - The zone maps written.
 * @param from - The first word read.
 * @param words - How many.
 * @param to - The first word written.
 */
export function copyZones(
  source: Record<SimilarityFingerprint, Zone>,
  target: Record<SimilarityFingerprint, Zone>,
  from: number,
  words: number,
  to: number,
): void {
  for (const fingerprint of FINGERPRINTS) {
    const { min, max } = source[fingerprint];
    target[fingerprint].min.set(min.subarray(from, from + words), to);
    target[fingerprint].max.set(max.subarray(from, from + words), to);
  }
}

function widen(zone: Zone, w: number, count: number): void {
  if (count < (zone.min[w] as number)) zone.min[w] = count;
  if (count > (zone.max[w] as number)) zone.max[w] = count;
}
