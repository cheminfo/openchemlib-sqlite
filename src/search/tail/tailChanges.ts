import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { readLastChange } from '../load/plan.ts';
import type { NormalizedSpec } from '../spec.ts';
import { memberParameters } from '../spec.ts';

import type { TailStatements } from './tailPoll.ts';
import type { TailStore } from './tailStore.ts';

/**
 * Applies the change log: every molecule it names after the last change applied is read again,
 * its columns (key, filters, alive) and its sets, unless the tail placed it after that change, as
 * the tables held it then. A log pruned past what the image applied is an error: the image must
 * be loaded again.
 * @param store - The tail store.
 * @param statements - The tail's statements.
 * @param db - The tail's read connection.
 * @param spec - The specification (its change log).
 * @param changeId - The last change applied.
 * @param placedAfter - Whether the tail placed a molecule after a change: the change is in it.
 * @returns The new last change applied, whether more remain, and how many molecules were read.
 */
export function applyChanges(
  store: TailStore,
  statements: TailStatements,
  db: DatabaseSync,
  spec: NormalizedSpec,
  changeId: number,
  placedAfter: (change: number, id: number) => boolean,
): { changeId: number; more: boolean; molecules: number } {
  const changes = spec.changes;
  if (changes === null) return { changeId, more: false, molecules: 0 };
  const last = readLastChange(db, changes.last);
  if (last <= changeId) return { changeId, more: false, molecules: 0 };
  const first = db.prepare(changes.first);
  first.setReturnArrays(true);
  const oldest = (first.get() as unknown[] | undefined)?.[0];
  // An empty log whose last id is past the image's was pruned past it too.
  if (
    oldest === null ||
    oldest === undefined ||
    Number(oldest) > changeId + 1
  ) {
    throw new Error(
      'the change log was pruned past the changes the image applied: load the index again',
    );
  }
  const read = db.prepare(changes.read);
  read.setReturnArrays(true);
  const rows = read.all({
    after: changeId,
    limit: store.options.changeBatch,
  }) as unknown as unknown[][];
  if (rows.length === 0) return { changeId, more: false, molecules: 0 };
  const ids = new Set<number>();
  for (const row of rows) {
    const id = Number(row[1]);
    if (!placedAfter(Number(row[0]), id)) ids.add(id);
  }
  let molecules = 0;
  for (const id of ids) if (refreshMolecule(store, statements, id)) molecules++;
  return {
    changeId: Number((rows.at(-1) as unknown[])[0]),
    more: rows.length === store.options.changeBatch,
    molecules,
  };
}

function refreshMolecule(
  store: TailStore,
  statements: TailStatements,
  id: number,
): boolean {
  const g = store.locate(id);
  if (g < 0) return false;
  const values =
    (statements.columns.get({ from: id, to: id }) as unknown as
      unknown[] | undefined) ?? null;
  store.rewriteRow(g, values);
  if (!store.bitmaps.isAlive(g)) return true;
  for (const set of store.bitmaps.sets.values()) {
    const statement = statements.members.get(set.family) as StatementSync;
    const parameters = memberParameters(set.value, id, id);
    store.bitmaps.setBit(set.words, g, statement.get(parameters) !== undefined);
  }
  return true;
}
