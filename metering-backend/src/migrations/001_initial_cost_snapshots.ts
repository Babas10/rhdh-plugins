import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTableIfNotExists('cost_snapshots', table => {
    table.increments('id').primary();
    table.text('entity_ref').notNullable();
    table.text('namespace').notNullable();
    table.text('deployment').notNullable();
    table.float('cpu_cores').notNullable();
    table.float('mem_gib').notNullable();
    table.float('hourly_cost').notNullable();
    table.timestamp('sampled_at').notNullable().defaultTo(knex.fn.now());
    table.index(['entity_ref', 'sampled_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cost_snapshots');
}
