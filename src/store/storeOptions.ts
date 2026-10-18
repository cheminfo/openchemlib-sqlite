/** Options of `MoleculeStore.open()`. */
export interface MoleculeStoreOptions {
  /**
   * Worker threads computing what the store holds, started on first use.
   * @default availableParallelism() - 1, at least 1
   */
  threads?: number;
  /**
   * Stored molecules recomputed from their idCodes when the store opens, to check the file against
   * this build; 0 skips the check.
   * @default 32
   */
  checkRows?: number;
  /**
   * The seed of that sample.
   * @default 1
   */
  checkSeed?: number;
  /**
   * Worker threads, each with a read-only connection of its own, that read the stored molecules
   * `find()` needs off the caller's thread and in parallel; 0 reads them on the caller's thread.
   * Needs a database file.
   * @default 0
   */
  readers?: number;
}

/** Options of the identity lookups that page through a group. */
export interface GroupOptions {
  /**
   * Only ids above this one.
   * @default 0
   */
  after?: number;
  /**
   * At most this many ids.
   * @default 1000
   */
  limit?: number;
}
