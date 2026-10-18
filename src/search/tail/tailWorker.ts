import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

import { openReader, readLastChange, readSets } from '../load/plan.ts';

import { applyChanges } from './tailChanges.ts';
import { Placements } from './tailPlacements.ts';
import type { TailStatements } from './tailPoll.ts';
import { prepareTailStatements, readNewRows } from './tailPoll.ts';
import { takeChanges, takeCheckpoint } from './tailPublish.ts';
import type { TailCounters, TailWorkerData } from './tailState.ts';
import { TailStore } from './tailStore.ts';

const port = parentPort as NonNullable<typeof parentPort>;
const data = workerData as TailWorkerData;
const store = new TailStore(data);
const stats = { polls: 0, rows: 0, changes: 0, anomalies: 0, errors: 0 };
let watermark = data.watermark;
let version = data.version;
let changeId = data.changeId;
let db: DatabaseSync | null = null;
let statements: TailStatements | null = null;
let dataVersion: StatementSync | null = null;
let metaSeq: StatementSync | null = null;
let metaStamp: StatementSync | null = null;
let lastDataVersion: unknown = null;
let more = false;
/** Whether the last publish said the file held more than its poll read. */
let toldMore = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let closing = false;
/** While a save reads the image: no poll runs, and the polls asked for wait. */
let paused = false;
let deferred: number[] = [];
/** Set when the tail can no longer follow the file: polls stop. */
let fatal: string | null = null;
const placements = new Placements();

function open(): void {
  db = openReader(data.file);
  statements = prepareTailStatements(db, data.spec);
  dataVersion = db.prepare('PRAGMA data_version');
  metaSeq = db.prepare("SELECT value FROM ocl_meta WHERE name = 'seq'");
  metaStamp = db.prepare("SELECT value FROM ocl_meta WHERE name = 'stamp'");
}

/**
 * Reads what the file gained since the last poll, in one read transaction: new set names, the
 * molecules above the watermark, the change log. Placing new rows is the one step that cannot be
 * repeated (a row placed twice would be answered twice), so a failure there stops the tail; a
 * failure of the change log only stops following it.
 * @param force - Poll even when the file did not change.
 */
function poll(force: boolean): void {
  if (fatal !== null) throw new Error(fatal);
  if (db === null) open();
  const connection = db as DatabaseSync;
  const [version] = Object.values(
    (dataVersion as StatementSync).get() as Record<string, number>,
  );
  if (!force && !more && version === lastDataVersion) return;
  lastDataVersion = version;
  more = false;
  stats.polls++;
  connection.exec('BEGIN');
  try {
    const stamp = (
      (metaStamp as StatementSync).get() as { value: unknown } | undefined
    )?.value;
    if (stamp !== data.options.stamp) {
      // Its tiles now hold bits this image's queries do not read: what is loaded stays answerable.
      fatal =
        'the file was rebuilt under another stamp: the index is no longer followed, open it with the build that rebuilt it';
      throw new Error(fatal);
    }
    const top =
      ((metaSeq as StatementSync).get() as { value: number } | undefined)
        ?.value ?? watermark;
    for (const set of readSets(connection, data.spec)) {
      store.bitmaps.addSet(set.name, set.family, set.value);
    }
    const cap =
      data.options.pollRows > 0 ? watermark + data.options.pollRows : Infinity;
    const next = Math.min(cap, top);
    // The rows placed now hold every change up to this one.
    const lastChange =
      changeId === null || data.spec.changes === null
        ? null
        : readLastChange(connection, data.spec.changes.last);
    try {
      const { placed, anomalies } = readNewRows(
        store,
        statements as TailStatements,
        watermark,
        next,
      );
      stats.rows += placed;
      stats.anomalies += anomalies;
    } catch (error) {
      fatal = `the tail stopped while placing new molecules: load the index again (${error instanceof Error ? error.message : String(error)})`;
      throw new Error(fatal, { cause: error });
    }
    if (next < top) more = true;
    if (next > watermark) {
      if (lastChange !== null) {
        placements.add(watermark, next, lastChange);
      }
      watermark = next;
      store.pending.any = true;
    }
    if (changeId !== null) {
      try {
        const applied = applyChanges(
          store,
          statements as TailStatements,
          connection,
          data.spec,
          changeId,
          (change, id) => placements.hold(change, id),
        );
        changeId = applied.changeId;
        more ||= applied.more;
        stats.changes += applied.molecules;
        placements.applied(applied.changeId);
      } catch (error) {
        // Changes to molecules already loaded are no longer followed; new molecules still are.
        changeId = null;
        report(error);
      }
    }
    connection.exec('COMMIT');
  } catch (error) {
    if (connection.isTransaction) connection.exec('ROLLBACK');
    throw error;
  }
}

function report(error: unknown): void {
  stats.errors++;
  port.postMessage({
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
  });
}

function counters(): TailCounters {
  return { rows: stats.rows, changes: stats.changes, more };
}

function publish(): void {
  if (
    !store.pending.any &&
    !store.bitmaps.changed &&
    store.pending.newBlocks.length === 0
  ) {
    // A catch-up the main thread was told of is over, though nothing changed: it hears so.
    if (toldMore && !more) {
      toldMore = false;
      port.postMessage({ type: 'caughtUp', counters: counters() });
    }
    return;
  }
  version++;
  toldMore = more;
  port.postMessage(takeChanges(store, version, watermark, counters()));
}

function tick(): void {
  timer = null;
  if (closing || paused || fatal !== null) return;
  try {
    poll(false);
    publish();
  } catch (error) {
    report(error);
  }
  schedule();
}

function schedule(): void {
  if (closing || paused || fatal !== null || timer !== null) return;
  timer = setTimeout(tick, more ? 0 : data.options.pollMs);
}

function pollNow(id: number): void {
  try {
    do {
      poll(true);
      publish();
    } while (more);
    port.postMessage({ type: 'polled', id, version, watermark });
  } catch (error) {
    port.postMessage({
      type: 'error',
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function answer(message: { type: string; id: number }): void {
  if (message.type === 'poll') {
    if (paused) deferred.push(message.id);
    else pollNow(message.id);
  } else if (message.type === 'pause') {
    paused = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const position = { version, watermark, changeId, fatal };
    port.postMessage({
      type: 'paused',
      id: message.id,
      checkpoint: takeCheckpoint(store, { ...position, counters: counters() }),
    });
  } else if (message.type === 'resume') {
    paused = false;
    const waiting = deferred;
    deferred = [];
    for (const id of waiting) pollNow(id);
    port.postMessage({ type: 'resumed', id: message.id });
    schedule();
  } else if (message.type === 'stats') {
    port.postMessage({
      type: 'stats',
      id: message.id,
      stats: {
        ...stats,
        moves: store.moves,
        blocks: store.blocks.length,
        version,
        watermark,
        changeId,
      },
    });
  } else {
    closing = true;
    if (timer !== null) clearTimeout(timer);
    db?.close();
    db = null;
    for (const id of deferred) {
      port.postMessage({ type: 'polled', id, version, watermark });
    }
    deferred = [];
    port.postMessage({ type: 'closed', id: message.id });
  }
}

port.on('message', (message: { type: string; id: number }) => {
  try {
    answer(message);
  } catch (error) {
    port.postMessage({
      type: 'error',
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
port.postMessage({ type: 'ready' });
timer = setTimeout(tick, data.options.pollMs);
