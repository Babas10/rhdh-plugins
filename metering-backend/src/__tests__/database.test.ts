import knex, { Knex } from 'knex';
import {
  runMigrations,
  insertSnapshot,
  getHistory,
  pruneOldSnapshots,
  runMonthlyRollup,
} from '../database';

/** Build an in-memory SQLite DB and run all migrations. */
async function createTestDb(): Promise<Knex> {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await runMigrations(db);
  return db;
}

/** Insert a snapshot with an explicit sampled_at timestamp (daysAgo from now). */
async function insertAt(db: Knex, entityRef: string, daysAgo: number, hourlyCost = 1): Promise<void> {
  const ts = new Date();
  ts.setDate(ts.getDate() - daysAgo);
  await db('cost_snapshots').insert({
    entity_ref: entityRef,
    namespace: 'ns',
    deployment: 'app',
    cpu_cores: 0.5,
    mem_gib: 1,
    hourly_cost: hourlyCost,
    gpu_count: 0,
    gpu_cost: 0,
    sampled_at: ts.toISOString(),
  });
}

/** Insert a snapshot at an explicit ISO timestamp string. */
async function insertAtIso(
  db: Knex,
  entityRef: string,
  isoTs: string,
  hourlyCost = 1,
  cpuCores = 0.5,
): Promise<void> {
  await db('cost_snapshots').insert({
    entity_ref: entityRef,
    namespace: 'ns',
    deployment: 'app',
    cpu_cores: cpuCores,
    mem_gib: 1,
    hourly_cost: hourlyCost,
    gpu_count: 0,
    gpu_cost: 0,
    sampled_at: isoTs,
  });
}

/**
 * Returns an ISO timestamp string for day D of two calendar months ago.
 * Using an absolute past month avoids month-boundary flakiness in relative
 * daysAgo helpers when tests run near the start of a month.
 */
function twoMonthsAgoIso(day = 1): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 2);
  d.setDate(day);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// runMigrations
// ---------------------------------------------------------------------------

describe('runMigrations', () => {
  it('creates cost_snapshots and cost_monthly_rollups tables', async () => {
    const db = await createTestDb();
    expect(await db.schema.hasTable('cost_snapshots')).toBe(true);
    expect(await db.schema.hasTable('cost_monthly_rollups')).toBe(true);
    await db.destroy();
  });

  it('is idempotent — running twice does not throw', async () => {
    const db = await createTestDb();
    await expect(runMigrations(db)).resolves.not.toThrow();
    await db.destroy();
  });
});

// ---------------------------------------------------------------------------
// insertSnapshot / getHistory (hourly tier only)
// ---------------------------------------------------------------------------

describe('insertSnapshot + getHistory (hourly tier)', () => {
  it('returns snapshots within the requested window', async () => {
    const db = await createTestDb();

    await insertSnapshot(db, {
      entityRef: 'component:default/app',
      namespace: 'ns',
      deployment: 'app',
      cpuCores: 0.5,
      memGiB: 1,
      hourlyCost: 0.01,
      gpuCount: 0,
      gpuCost: 0,
    });

    const history = await getHistory(db, 'component:default/app', 30);
    expect(history).toHaveLength(1);
    expect(history[0].hourlyCost).toBeCloseTo(0.01);
    expect(history[0].cpuCores).toBeCloseTo(0.5);
    await db.destroy();
  });

  it('excludes snapshots outside the window', async () => {
    const db = await createTestDb();
    await insertAt(db, 'component:default/app', 40); // 40 days ago, outside a 30-day window
    const history = await getHistory(db, 'component:default/app', 30);
    expect(history).toHaveLength(0);
    await db.destroy();
  });

  it('returns results in ascending sampledAt order', async () => {
    const db = await createTestDb();
    await insertAt(db, 'component:default/app', 5);
    await insertAt(db, 'component:default/app', 2);
    await insertAt(db, 'component:default/app', 10);

    const history = await getHistory(db, 'component:default/app', 30);
    expect(history).toHaveLength(3);
    expect(history[0].sampledAt.getTime()).toBeLessThan(history[1].sampledAt.getTime());
    expect(history[1].sampledAt.getTime()).toBeLessThan(history[2].sampledAt.getTime());
    await db.destroy();
  });
});

// ---------------------------------------------------------------------------
// pruneOldSnapshots
// ---------------------------------------------------------------------------

describe('pruneOldSnapshots', () => {
  it('removes rows older than retentionDays', async () => {
    const db = await createTestDb();
    await insertAt(db, 'component:default/app', 100); // old
    await insertAt(db, 'component:default/app', 5);   // recent

    const deleted = await pruneOldSnapshots(db, 90);
    expect(deleted).toBe(1);

    const remaining = await db('cost_snapshots').count('* as n');
    expect(Number(remaining[0].n)).toBe(1);
    await db.destroy();
  });

  it('returns 0 when nothing qualifies', async () => {
    const db = await createTestDb();
    await insertAt(db, 'component:default/app', 5);
    const deleted = await pruneOldSnapshots(db, 90);
    expect(deleted).toBe(0);
    await db.destroy();
  });
});

// ---------------------------------------------------------------------------
// runMonthlyRollup
// ---------------------------------------------------------------------------

describe('runMonthlyRollup', () => {
  it('returns 0 when no rows are old enough', async () => {
    const db = await createTestDb();
    await insertAt(db, 'component:default/app', 5); // only 5 days old, under 30-day threshold
    const rolled = await runMonthlyRollup(db, 30);
    expect(rolled).toBe(0);
    await db.destroy();
  });

  it('aggregates old hourly rows into cost_monthly_rollups', async () => {
    const db = await createTestDb();
    // Insert 3 old rows all in the same calendar month (two months ago, days 1/2/3).
    // Using twoMonthsAgoIso avoids month-boundary flakiness with relative daysAgo.
    await insertAtIso(db, 'component:default/app', twoMonthsAgoIso(1), 2);
    await insertAtIso(db, 'component:default/app', twoMonthsAgoIso(2), 4);
    await insertAtIso(db, 'component:default/app', twoMonthsAgoIso(3), 6);

    const deleted = await runMonthlyRollup(db, 30);
    expect(deleted).toBe(3);

    const rollups = await db('cost_monthly_rollups')
      .where('entity_ref', 'component:default/app')
      .select('*');

    expect(rollups).toHaveLength(1);
    expect(Number(rollups[0].sample_count)).toBe(3);
    expect(Number(rollups[0].avg_cpu_cores)).toBeCloseTo(0.5);
    expect(Number(rollups[0].total_cost)).toBeCloseTo(2 + 4 + 6);
    await db.destroy();
  });

  it('deletes rolled-up hourly rows from cost_snapshots', async () => {
    const db = await createTestDb();
    await insertAt(db, 'component:default/app', 35);
    await insertAt(db, 'component:default/app', 5); // recent, must not be deleted

    await runMonthlyRollup(db, 30);

    const remaining = await db('cost_snapshots').count('* as n');
    expect(Number(remaining[0].n)).toBe(1); // only the recent one survives
    await db.destroy();
  });

  it('accumulates partial nightly slices into the same monthly row correctly', async () => {
    // This test specifically exercises the incremental (additive) upsert.
    // Night 1: roll up day-1 row (hourlyCost=10, cpu=0.5).
    // Night 2: day-2 row (hourlyCost=20, cpu=1.0) ages past the cutoff and is rolled up.
    // Expected final state: one rollup row with total_cost=30, sample_count=2,
    //   avg_cpu_cores=0.75 (weighted avg: (0.5*1 + 1.0*1) / 2).
    // A plain .merge() overwrite would produce total_cost=20, sample_count=1 — this
    // test catches that regression.
    const db = await createTestDb();

    // Row A: cpu=0.5, hourlyCost=10
    await insertAtIso(db, 'component:default/app', twoMonthsAgoIso(1), 10, 0.5);
    await runMonthlyRollup(db, 30);
    // Stored after night 1: avg_cpu_cores=0.5, total_cost=10, sample_count=1

    // Simulate a second slice for the same month arriving on a later nightly run
    // Row B: cpu=1.0, hourlyCost=20
    await insertAtIso(db, 'component:default/app', twoMonthsAgoIso(2), 20, 1.0);
    await runMonthlyRollup(db, 30);
    // Expected after night 2 (additive): total_cost=30, sample_count=2,
    //   avg_cpu_cores = (0.5*1 + 1.0*1) / (1+1) = 0.75
    // A plain .merge() overwrite would produce total_cost=20, sample_count=1 — regression.

    const rollups = await db('cost_monthly_rollups')
      .where('entity_ref', 'component:default/app')
      .select('*');

    expect(rollups).toHaveLength(1);
    expect(Number(rollups[0].sample_count)).toBe(2);
    expect(Number(rollups[0].total_cost)).toBeCloseTo(30);
    expect(Number(rollups[0].avg_cpu_cores)).toBeCloseTo(0.75); // weighted avg
    await db.destroy();
  });

  it('leaves recent snapshots untouched', async () => {
    const db = await createTestDb();
    await insertAt(db, 'component:default/app', 5);  // recent
    await insertAt(db, 'component:default/app', 10); // recent

    await runMonthlyRollup(db, 30);

    const snapshots = await db('cost_snapshots').count('* as n');
    expect(Number(snapshots[0].n)).toBe(2);
    const rollups = await db('cost_monthly_rollups').count('* as n');
    expect(Number(rollups[0].n)).toBe(0);
    await db.destroy();
  });
});

// ---------------------------------------------------------------------------
// getHistory — two-tier UNION
// ---------------------------------------------------------------------------

describe('getHistory (two-tier UNION)', () => {
  it('combines monthly rollups and hourly snapshots in ascending order', async () => {
    const db = await createTestDb();

    // Insert a monthly rollup row (representing old data)
    await db('cost_monthly_rollups').insert({
      entity_ref: 'component:default/app',
      namespace: 'ns',
      deployment: 'app',
      month_start: (() => {
        const d = new Date();
        d.setDate(d.getDate() - 45);
        return d.toISOString().slice(0, 10);
      })(),
      avg_cpu_cores: 1.0,
      avg_mem_gib: 2.0,
      avg_gpu_count: 0,
      total_cost: 72,   // 72 = 3 * 24h avg ~= 1/h over a month
      sample_count: 72,
    });

    // Insert a recent hourly snapshot
    await insertAt(db, 'component:default/app', 2, 0.5);

    const history = await getHistory(db, 'component:default/app', 60);

    expect(history).toHaveLength(2);
    // Monthly rollup comes first (older)
    expect(history[0].hourlyCost).toBeCloseTo(72 / 72);
    expect(history[0].cpuCores).toBeCloseTo(1.0);
    // Hourly snapshot comes second (recent)
    expect(history[1].hourlyCost).toBeCloseTo(0.5);
    expect(history[0].sampledAt.getTime()).toBeLessThan(history[1].sampledAt.getTime());
    await db.destroy();
  });

  it('returns only rollups when all data is old', async () => {
    const db = await createTestDb();
    await db('cost_monthly_rollups').insert({
      entity_ref: 'component:default/app',
      namespace: 'ns',
      deployment: 'app',
      month_start: (() => {
        const d = new Date();
        d.setDate(d.getDate() - 45);
        return d.toISOString().slice(0, 10);
      })(),
      avg_cpu_cores: 0.5,
      avg_mem_gib: 1,
      avg_gpu_count: 0,
      total_cost: 10,
      sample_count: 10,
    });

    const history = await getHistory(db, 'component:default/app', 60);
    expect(history).toHaveLength(1);
    expect(history[0].cpuCores).toBeCloseTo(0.5);
    await db.destroy();
  });

  it('returns empty array when entity has no data in either tier', async () => {
    const db = await createTestDb();
    const history = await getHistory(db, 'component:default/unknown', 30);
    expect(history).toHaveLength(0);
    await db.destroy();
  });
});
