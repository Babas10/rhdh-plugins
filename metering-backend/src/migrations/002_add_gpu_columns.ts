import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasGpuCount = await knex.schema.hasColumn('cost_snapshots', 'gpu_count');
  if (!hasGpuCount) {
    await knex.schema.alterTable('cost_snapshots', table => {
      table.float('gpu_count').notNullable().defaultTo(0);
      table.float('gpu_cost').notNullable().defaultTo(0);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('cost_snapshots', table => {
    table.dropColumn('gpu_count');
    table.dropColumn('gpu_cost');
  });
}
