import { Knex } from 'knex';

/**
 * ADR-06: introduce cost_daily_aggregates as the middle tier of the
 * three-tier storage model.
 *
 * Tier 1 — cost_snapshots       (hourly, last rollupAfterDays)
 * Tier 2 — cost_daily_aggregates (daily, kept forever)       ← this table
 * Tier 3 — cost_monthly_rollups  (monthly, kept forever)
 *
 * The nightly rollup job now creates one daily row per entity per calendar
 * day before deleting the source hourly rows. This allows monthly cost
 * reports to always show a full daily breakdown, regardless of the month's
 * age — without the storage cost of keeping hourly rows indefinitely.
 *
 * Volume estimate: 1 entity × 365 days/year × 5 years = 1,825 rows.
 * Even at 100 entities over 10 years this table stays under 400 k rows.
 *
 * The UNIQUE constraint on (entity_ref, date) makes the upsert idempotent.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTableIfNotExists('cost_daily_aggregates', table => {
    table.increments('id').primary();
    table.text('entity_ref').notNullable();
    table.text('namespace').notNullable();
    table.text('deployment').notNullable();
    table.date('date').notNullable();
    table.float('avg_cpu_cores').notNullable();
    table.float('avg_mem_gib').notNullable();
    table.float('avg_gpu_count').notNullable().defaultTo(0);
    table.float('total_cost').notNullable();
    table.integer('sample_count').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['entity_ref', 'date']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cost_daily_aggregates');
}
