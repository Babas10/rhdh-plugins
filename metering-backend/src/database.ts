import { Knex } from 'knex';
import { CostSnapshot } from './types';
import * as migration001 from './migrations/001_initial_cost_snapshots';
import * as migration002 from './migrations/002_add_gpu_columns';
import * as migration003 from './migrations/003_create_cost_monthly_rollups';
import * as migration004 from './migrations/004_create_cost_daily_aggregates';

/** Returns true when running against SQLite (local dev / tests). */
function isSQLite(knex: Knex): boolean {
  const client: string = (knex.client as any).config?.client ?? '';
  return client === 'sqlite3' || client === 'better-sqlite3';
}

/** Truncates a timestamp column to the first day of its month (dialect-aware). */
function monthTruncExpr(knex: Knex, column: string): string {
  return isSQLite(knex)
    ? `strftime('%Y-%m-01', ${column})`
    : `date_trunc('month', ${column})::date`;
}

/** Truncates a timestamp column to its calendar date (dialect-aware). */
function dateTruncExpr(knex: Knex, column: string): string {
  return isSQLite(knex)
    ? `strftime('%Y-%m-%d', ${column})`
    : `DATE(${column})`;
}

// Ordered list of all migrations. Static imports ensure the build tool
// includes every migration file in the compiled output — the previous
// path.resolve(__dirname, 'migrations') directory scan only worked in
// local TypeScript dev because the compiled dist/ never contained a
// migrations/ subdirectory.
const MIGRATIONS = [
  { name: '001_initial_cost_snapshots',       module: migration001 },
  { name: '002_add_gpu_columns',              module: migration002 },
  { name: '003_create_cost_monthly_rollups',  module: migration003 },
  { name: '004_create_cost_daily_aggregates', module: migration004 },
] as const;

const migrationSource = {
  getMigrations: () => Promise.resolve([...MIGRATIONS]),
  getMigrationName: (m: (typeof MIGRATIONS)[number]) => m.name,
  getMigration:     (m: (typeof MIGRATIONS)[number]) => Promise.resolve(m.module),
};

/**
 * Run all pending Knex migrations.
 *
 * Migrations are registered via static imports so the build tool bundles
 * them into the compiled output. Knex tracks applied migrations in its own
 * knex_migrations table — this call is idempotent and safe on every startup.
 *
 * To add a new migration: create migrations/NNN_<description>.ts, add it to
 * the MIGRATIONS array above, and bump the import at the top of this file.
 */
export async function runMigrations(knex: Knex): Promise<void> {
  await knex.migrate.latest({ migrationSource });
}

export async function insertSnapshot(
  knex: Knex,
  snapshot: Omit<CostSnapshot, 'id' | 'sampledAt' | 'totalCost'>,
): Promise<void> {
  await knex('cost_snapshots').insert({
    entity_ref: snapshot.entityRef,
    namespace: snapshot.namespace,
    deployment: snapshot.deployment,
    cpu_cores: snapshot.cpuCores,
    mem_gib: snapshot.memGiB,
    hourly_cost: snapshot.hourlyCost,
    gpu_count: snapshot.gpuCount,
    gpu_cost: snapshot.gpuCost,
    sampled_at: new Date().toISOString(),
  });
}

/**
 * Returns a unified time series for an entity spanning both storage tiers:
 *   - cost_snapshots       (hourly, recent — within the requested window)
 *   - cost_monthly_rollups (monthly aggregates — older data promoted by the rollup job)
 *
 * Monthly rollup rows are synthesised into CostSnapshot shape using:
 *   hourlyCost = total_cost / sample_count   (average hourly cost for that month)
 *   sampledAt  = month_start                 (first day of the month)
 *
 * The two result sets are merged and sorted ascending by sampledAt so the
 * caller always receives a single ordered series regardless of data age.
 */
export async function getHistory(
  knex: Knex,
  entityRef: string,
  days: number,
): Promise<CostSnapshot[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Tier 1: hourly snapshots (recent data)
  const hourlyRows = await knex('cost_snapshots')
    .where('entity_ref', entityRef)
    .where('sampled_at', '>=', since.toISOString())
    .orderBy('sampled_at', 'asc')
    .select('*');

  const hourly: CostSnapshot[] = hourlyRows.map(
    (r: {
      id: number;
      entity_ref: string;
      namespace: string;
      deployment: string;
      cpu_cores: number;
      mem_gib: number;
      hourly_cost: number;
      gpu_count: number;
      gpu_cost: number;
      sampled_at: Date;
    }) => ({
      id: r.id,
      entityRef: r.entity_ref,
      namespace: r.namespace,
      deployment: r.deployment,
      cpuCores: r.cpu_cores,
      memGiB: r.mem_gib,
      hourlyCost: r.hourly_cost,
      totalCost: r.hourly_cost,  // one hour's worth
      gpuCount: r.gpu_count ?? 0,
      gpuCost: r.gpu_cost ?? 0,
      sampledAt: new Date(r.sampled_at),
    }),
  );

  // Tier 2: monthly rollups (older data promoted by the nightly rollup job)
  const sinceDate = since.toISOString().slice(0, 10);
  const rollupRows = await knex('cost_monthly_rollups')
    .where('entity_ref', entityRef)
    .where('month_start', '>=', sinceDate)
    .orderBy('month_start', 'asc')
    .select('*');

  const rollups: CostSnapshot[] = rollupRows.map(
    (r: {
      id: number;
      entity_ref: string;
      namespace: string;
      deployment: string;
      month_start: string;
      avg_cpu_cores: number;
      avg_mem_gib: number;
      avg_gpu_count: number;
      total_cost: number;
      sample_count: number;
    }) => ({
      id: r.id,
      entityRef: r.entity_ref,
      namespace: r.namespace,
      deployment: r.deployment,
      cpuCores: r.avg_cpu_cores,
      memGiB: r.avg_mem_gib,
      hourlyCost: r.sample_count > 0 ? r.total_cost / r.sample_count : 0,
      totalCost: r.total_cost,  // actual monthly total — NOT divided by sample count
      gpuCount: r.avg_gpu_count ?? 0,
      gpuCost: 0,
      sampledAt: new Date(r.month_start),
    }),
  );

  // Merge tiers and sort by time ascending
  return [...rollups, ...hourly].sort(
    (a, b) => a.sampledAt.getTime() - b.sampledAt.getTime(),
  );
}

// ── Report helpers ────────────────────────────────────────────────────────────

export interface DailyReportRow {
  date: string;          // "YYYY-MM-DD"
  avgCpuCores: number;
  avgMemGiB: number;
  avgGpuCount: number;
  dailyCost: number;     // sum of all hourly costs for that day
  sampleCount: number;
}

export interface MonthlyReportSummary {
  totalCost: number;
  avgDailyCost: number;
  peakDate: string | null;
  peakCost: number;
  avgCpuCores: number;
  avgMemGiB: number;
  sampleCount: number;
}

export interface MonthlyReportResult {
  entityRef: string;
  month: string;              // "YYYY-MM"
  hasDailyBreakdown: boolean; // false when hourly rows were already rolled up
  dailyRows: DailyReportRow[];
  summary: MonthlyReportSummary | null;
}

/**
 * Returns the list of months that have cost data for the given entity,
 * drawn from both storage tiers. Sorted newest-first so the picker
 * defaults to the most recent available month.
 *
 * `hasDailyData` is true when hourly rows still exist in cost_snapshots
 * (i.e. the month is within rollupAfterDays). Once a month has been rolled
 * up and its hourly rows deleted, only the monthly aggregate is available.
 */
export async function getAvailableMonths(
  knex: Knex,
  entityRef: string,
): Promise<Array<{ month: string; hasDailyData: boolean }>> {
  const monthExpr = monthTruncExpr(knex, 'sampled_at');

  const snapshotMonths: Array<{ month_start: string }> = await knex('cost_snapshots')
    .where('entity_ref', entityRef)
    .groupByRaw(`${monthExpr}`)
    .select(knex.raw(`${monthExpr} as month_start`));

  const rollupMonths: Array<{ month_start: string }> = await knex('cost_monthly_rollups')
    .where('entity_ref', entityRef)
    .orderBy('month_start', 'desc')
    .select('month_start');

  // Months covered by daily aggregates (Tier 2) — always have daily breakdown
  const dailyMonthExpr = monthTruncExpr(knex, 'date');
  const dailyAggMonths: Array<{ month_start: string }> = await knex('cost_daily_aggregates')
    .where('entity_ref', entityRef)
    .groupByRaw(`${dailyMonthExpr}`)
    .select(knex.raw(`${dailyMonthExpr} as month_start`));

  const snapshotSet = new Set(snapshotMonths.map(r => String(r.month_start).slice(0, 7)));
  const dailySet    = new Set(dailyAggMonths.map(r => String(r.month_start).slice(0, 7)));

  const months = new Map<string, boolean>(); // month → hasDailyData

  for (const r of rollupMonths) {
    const month = String(r.month_start).slice(0, 7);
    // hasDailyData = true when hourly OR daily-aggregate rows cover this month
    months.set(month, snapshotSet.has(month) || dailySet.has(month));
  }

  for (const month of snapshotSet) {
    if (!months.has(month)) months.set(month, true);
  }
  for (const month of dailySet) {
    if (!months.has(month)) months.set(month, true);
  }

  return Array.from(months.entries())
    .map(([month, hasDailyData]) => ({ month, hasDailyData }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

/**
 * Builds a full report for the requested month:
 *   - Daily rows: aggregated from cost_snapshots (if still present)
 *   - Summary: from cost_monthly_rollups when available, otherwise
 *              computed from the daily rows
 *
 * When the month has been rolled up and hourly rows were deleted,
 * `hasDailyBreakdown` is false and `dailyRows` is empty — only the
 * monthly summary is returned.
 */
export async function getMonthlyReport(
  knex: Knex,
  entityRef: string,
  month: string, // "YYYY-MM"
): Promise<MonthlyReportResult> {
  const monthStart = `${month}-01`;
  const nextDate = new Date(`${monthStart}T00:00:00Z`);
  nextDate.setUTCMonth(nextDate.getUTCMonth() + 1);
  const monthEnd = nextDate.toISOString().slice(0, 10);

  const dayExpr = dateTruncExpr(knex, 'sampled_at');

  // Try Tier 1 first: group hourly rows from cost_snapshots by day
  const rawFromSnapshots: Array<{
    date: string; avg_cpu: number; avg_mem: number; avg_gpu: number;
    daily_cost: number; sample_count: number;
  }> = await knex('cost_snapshots')
    .where('entity_ref', entityRef)
    .where('sampled_at', '>=', `${monthStart}T00:00:00.000Z`)
    .where('sampled_at', '<',  `${monthEnd}T00:00:00.000Z`)
    .groupByRaw(dayExpr).orderByRaw(dayExpr)
    .select(
      knex.raw(`${dayExpr} as date`),
      knex.raw('AVG(cpu_cores) as avg_cpu'), knex.raw('AVG(mem_gib) as avg_mem'),
      knex.raw('AVG(gpu_count) as avg_gpu'), knex.raw('SUM(hourly_cost) as daily_cost'),
      knex.raw('COUNT(*) as sample_count'),
    );

  // Fall back to Tier 2: pre-computed daily aggregates (populated by rollup job)
  const rawFromDaily: Array<{
    date: string; avg_cpu_cores: number; avg_mem_gib: number; avg_gpu_count: number;
    total_cost: number; sample_count: number;
  }> = rawFromSnapshots.length === 0
    ? await knex('cost_daily_aggregates')
        .where('entity_ref', entityRef)
        .where('date', '>=', monthStart)
        .where('date', '<',  monthEnd)
        .orderBy('date', 'asc')
        .select('date', 'avg_cpu_cores', 'avg_mem_gib', 'avg_gpu_count', 'total_cost', 'sample_count')
    : [];

  const dailyRows: DailyReportRow[] = rawFromSnapshots.length > 0
    ? rawFromSnapshots.map(r => ({
        date: String(r.date), avgCpuCores: Number(r.avg_cpu), avgMemGiB: Number(r.avg_mem),
        avgGpuCount: Number(r.avg_gpu) || 0, dailyCost: Number(r.daily_cost),
        sampleCount: Number(r.sample_count),
      }))
    : rawFromDaily.map(r => ({
        date: String(r.date), avgCpuCores: Number(r.avg_cpu_cores), avgMemGiB: Number(r.avg_mem_gib),
        avgGpuCount: Number(r.avg_gpu_count) || 0, dailyCost: Number(r.total_cost),
        sampleCount: Number(r.sample_count),
      }));

  // Monthly rollup (may exist even when daily rows are still present for
  // partial months that started being rolled up mid-month)
  const rollup = await knex('cost_monthly_rollups')
    .where('entity_ref', entityRef)
    .where('month_start', monthStart)
    .first();

  if (dailyRows.length === 0 && !rollup) {
    return { entityRef, month, hasDailyBreakdown: false, dailyRows: [], summary: null };
  }

  // Prefer rollup for the monthly total when available (authoritative);
  // fall back to summing the daily rows for months not yet rolled up.
  const totalCost    = rollup ? Number(rollup.total_cost)    : dailyRows.reduce((s, r) => s + r.dailyCost, 0);
  const avgCpuCores  = rollup ? Number(rollup.avg_cpu_cores) : dailyRows.reduce((s, r) => s + r.avgCpuCores, 0) / dailyRows.length;
  const avgMemGiB    = rollup ? Number(rollup.avg_mem_gib)   : dailyRows.reduce((s, r) => s + r.avgMemGiB, 0)   / dailyRows.length;
  const sampleCount  = rollup ? Number(rollup.sample_count)  : dailyRows.reduce((s, r) => s + r.sampleCount, 0);

  const peakRow = dailyRows.reduce<DailyReportRow | null>(
    (max, r) => (max === null || r.dailyCost > max.dailyCost ? r : max),
    null,
  );

  return {
    entityRef,
    month,
    hasDailyBreakdown: dailyRows.length > 0,
    dailyRows,
    summary: {
      totalCost,
      avgDailyCost: dailyRows.length > 0 ? totalCost / dailyRows.length : totalCost / 30,
      peakDate: peakRow?.date ?? null,
      peakCost: peakRow?.dailyCost ?? 0,
      avgCpuCores,
      avgMemGiB,
      sampleCount,
    },
  };
}

export async function pruneOldSnapshots(
  knex: Knex,
  retentionDays: number,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const deleted = await knex('cost_snapshots')
    .where('sampled_at', '<', cutoff.toISOString())
    .delete();

  return deleted;
}

/**
 * ADR-05 nightly rollup: aggregates hourly snapshot rows that are older than
 * rollupAfterDays into the cost_monthly_rollups table, then deletes the source rows.
 *
 * The upsert is ADDITIVE: when a row already exists for (entity_ref, month_start),
 * total_cost and sample_count are summed and the running averages are recomputed as
 * weighted averages so that each nightly run correctly accumulates the new slice of
 * hourly rows rather than overwriting the stored aggregate.
 *
 * This design is safe for the normal usage pattern where the cutoff is a moving
 * window (now − rollupAfterDays): new hourly rows age past it each night, get
 * aggregated into the monthly row, and are then deleted — each night's slice is
 * non-overlapping with previous runs for the same month.
 *
 * Returns the number of hourly rows that were deleted after being rolled up.
 * Returns 0 if there is nothing old enough to roll up yet.
 */
export async function runMonthlyRollup(
  knex: Knex,
  rollupAfterDays: number,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - rollupAfterDays);
  const cutoffIso = cutoff.toISOString();

  const dayExpr   = dateTruncExpr(knex, 'sampled_at');
  const monthExpr = monthTruncExpr(knex, 'sampled_at');

  // ── Step 1: write daily aggregates (ADR-06) ────────────────────────────
  // Before deleting hourly rows, group them by calendar day and upsert into
  // cost_daily_aggregates so reports can always show daily breakdowns.
  const dailyGroups: Array<{
    entity_ref: string; namespace: string; deployment: string;
    date: string; avg_cpu: number; avg_mem: number; avg_gpu: number;
    total_cost: number; sample_count: number;
  }> = await knex('cost_snapshots')
    .where('sampled_at', '<', cutoffIso)
    .groupByRaw(`entity_ref, namespace, deployment, ${dayExpr}`)
    .select(
      'entity_ref', 'namespace', 'deployment',
      knex.raw(`${dayExpr} as date`),
      knex.raw('AVG(cpu_cores)   as avg_cpu'),
      knex.raw('AVG(mem_gib)     as avg_mem'),
      knex.raw('AVG(gpu_count)   as avg_gpu'),
      knex.raw('SUM(hourly_cost) as total_cost'),
      knex.raw('COUNT(*)         as sample_count'),
    );

  if (dailyGroups.length > 0) {
    await knex('cost_daily_aggregates')
      .insert(dailyGroups.map(g => ({
        entity_ref:    g.entity_ref,
        namespace:     g.namespace,
        deployment:    g.deployment,
        date:          g.date,
        avg_cpu_cores: Number(g.avg_cpu),
        avg_mem_gib:   Number(g.avg_mem),
        avg_gpu_count: Number(g.avg_gpu) || 0,
        total_cost:    Number(g.total_cost),
        sample_count:  Number(g.sample_count),
      })))
      .onConflict(['entity_ref', 'date'])
      .merge({
        total_cost:   knex.raw('cost_daily_aggregates.total_cost + excluded.total_cost'),
        sample_count: knex.raw('cost_daily_aggregates.sample_count + excluded.sample_count'),
        avg_cpu_cores: knex.raw(
          '(cost_daily_aggregates.avg_cpu_cores * cost_daily_aggregates.sample_count' +
          ' + excluded.avg_cpu_cores * excluded.sample_count)' +
          ' / (cost_daily_aggregates.sample_count + excluded.sample_count)',
        ),
        avg_mem_gib: knex.raw(
          '(cost_daily_aggregates.avg_mem_gib * cost_daily_aggregates.sample_count' +
          ' + excluded.avg_mem_gib * excluded.sample_count)' +
          ' / (cost_daily_aggregates.sample_count + excluded.sample_count)',
        ),
        avg_gpu_count: knex.raw(
          '(cost_daily_aggregates.avg_gpu_count * cost_daily_aggregates.sample_count' +
          ' + excluded.avg_gpu_count * excluded.sample_count)' +
          ' / (cost_daily_aggregates.sample_count + excluded.sample_count)',
        ),
      });
  }

  // ── Step 2: monthly aggregates ────────────────────────────────────────

  const groups: Array<{
    entity_ref: string;
    namespace: string;
    deployment: string;
    month_start: string;
    avg_cpu_cores: number;
    avg_mem_gib: number;
    avg_gpu_count: number;
    total_cost: number;
    sample_count: number;
  }> = await knex('cost_snapshots')
    .where('sampled_at', '<', cutoffIso)
    .groupByRaw(`entity_ref, namespace, deployment, ${monthExpr}`)
    .select(
      'entity_ref',
      'namespace',
      'deployment',
      knex.raw(`${monthExpr} as month_start`),
      knex.raw('AVG(cpu_cores) as avg_cpu_cores'),
      knex.raw('AVG(mem_gib) as avg_mem_gib'),
      knex.raw('AVG(gpu_count) as avg_gpu_count'),
      knex.raw('SUM(hourly_cost) as total_cost'),
      knex.raw('COUNT(*) as sample_count'),
    );

  if (groups.length === 0) return 0;

  // Upsert each monthly group with an ADDITIVE merge on conflict.
  // Both SQLite and PostgreSQL support the `excluded` pseudo-table in DO UPDATE.
  // Means are recomputed as weighted averages so accumulated slices combine correctly.
  await knex('cost_monthly_rollups')
    .insert(
      groups.map(g => ({
        entity_ref: g.entity_ref,
        namespace: g.namespace,
        deployment: g.deployment,
        month_start: g.month_start,
        avg_cpu_cores: Number(g.avg_cpu_cores),
        avg_mem_gib: Number(g.avg_mem_gib),
        avg_gpu_count: Number(g.avg_gpu_count) || 0,
        total_cost: Number(g.total_cost),
        sample_count: Number(g.sample_count),
      })),
    )
    .onConflict(['entity_ref', 'month_start'])
    .merge({
      total_cost: knex.raw(
        'cost_monthly_rollups.total_cost + excluded.total_cost',
      ),
      sample_count: knex.raw(
        'cost_monthly_rollups.sample_count + excluded.sample_count',
      ),
      avg_cpu_cores: knex.raw(
        '(cost_monthly_rollups.avg_cpu_cores * cost_monthly_rollups.sample_count' +
          ' + excluded.avg_cpu_cores * excluded.sample_count)' +
          ' / (cost_monthly_rollups.sample_count + excluded.sample_count)',
      ),
      avg_mem_gib: knex.raw(
        '(cost_monthly_rollups.avg_mem_gib * cost_monthly_rollups.sample_count' +
          ' + excluded.avg_mem_gib * excluded.sample_count)' +
          ' / (cost_monthly_rollups.sample_count + excluded.sample_count)',
      ),
      avg_gpu_count: knex.raw(
        '(cost_monthly_rollups.avg_gpu_count * cost_monthly_rollups.sample_count' +
          ' + excluded.avg_gpu_count * excluded.sample_count)' +
          ' / (cost_monthly_rollups.sample_count + excluded.sample_count)',
      ),
    });

  // Delete the rolled-up hourly rows
  const deleted = await knex('cost_snapshots')
    .where('sampled_at', '<', cutoffIso)
    .delete();

  return deleted;
}
