/** The most hits one page answers. */
export const MAX_PAGE_LIMIT = 1_000_000;

/**
 * The hits a page asks for, checked before any worker sizes a buffer by it.
 * @param limit - The option given.
 * @returns It, 24 when not given.
 * @throws {Error} When it is not a whole number from 1 to MAX_PAGE_LIMIT.
 */
export function pageLimit(limit: number | undefined): number {
  const value = limit ?? 24;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new Error(
      `limit is a whole number from 1 to ${MAX_PAGE_LIMIT}, not ${String(limit)}`,
    );
  }
  return value;
}
