import { Knex } from 'knex';

/**
 * ADR-05: introduce the cost_monthly_rollups table for the two-tier storage model.
 *
 * Hourly rows older than metering.rollupAfterDays are aggregated into this table
 * by the nightly rollup task and then deleted from cost_snapshots, keeping the
 * hourly table small while preserving long-term trend data at monthly granularity.
 *
 * The UNIQUE constraint on (entity_ref, month_start) makes the nightly upsert
 * idempotent — re-running the rollup for the same month is always safe.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTableIfNotExists('cost_monthly_rollups', table => {
    table.increments('id').primary();
    table.text('entity_ref').notNullable();
    table.text('namespace').notNullable();
    table.text('deployment').notNullable();
    table.date('month_start').notNullable();
    table.float('avg_cpu_cores').notNullable();
    table.float('avg_mem_gib').notNullable();
    table.float('avg_gpu_count').notNullable().defaultTo(0);
    table.float('total_cost').notNullable();
    table.integer('sample_count').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['entity_ref', 'month_start']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cost_monthly_rollups');
}
