import {
  LoggerService,
  SchedulerService,
  DatabaseService,
  AuthService,
} from '@backstage/backend-plugin-api';
import { CatalogService } from '@backstage/plugin-catalog-node';
import { ComponentEntity } from '@backstage/catalog-model';
import { LRUCache } from 'lru-cache';
import { Knex } from 'knex';
import { PrometheusClient } from './prometheusClient';
import { CostCalculator } from './costCalculator';
import { MeteringConfig } from './types';
import { insertSnapshot, pruneOldSnapshots, runMonthlyRollup } from './database';

const ANNOTATION_KUBERNETES_NAMESPACE = 'backstage.io/kubernetes-namespace';
const ANNOTATION_KUBERNETES_ID = 'backstage.io/kubernetes-id';

export function createSnapshotScheduler(
  config: MeteringConfig,
  logger: LoggerService,
  scheduler: SchedulerService,
  database: DatabaseService,
  catalog: CatalogService,
  auth: AuthService,
): void {
  const prometheusClient = new PrometheusClient(
    config.prometheusUrl,
    logger,
    config.bearerToken,
  );
  const costCalculator = new CostCalculator(config);

  // Prevent writing two snapshots within 50 min for the same entity (scheduler jitter guard)
  const snapshotCache = new LRUCache<string, boolean>({
    max: 1000,
    ttl: 50 * 60 * 1000,
  });

  // Nightly rollup: promotes hourly rows older than rollupAfterDays into
  // cost_monthly_rollups and deletes the source rows (ADR-05).
  scheduler.scheduleTask({
    id: 'metering-monthly-rollup',
    frequency: { hours: 24 },
    timeout: { minutes: 15 },
    initialDelay: { minutes: 5 },
    fn: async () => {
      logger.info('Metering: running nightly monthly rollup');
      const knex = (await database.getClient()) as unknown as Knex;
      const rolled = await runMonthlyRollup(knex, config.rollupAfterDays);
      if (rolled > 0) {
        logger.info(
          `Metering: rolled up ${rolled} hourly snapshots into monthly aggregates`,
        );
      } else {
        logger.debug('Metering: no hourly snapshots old enough to roll up');
      }
    },
  });

  scheduler.scheduleTask({
    id: 'metering-snapshot',
    frequency: { hours: 1 },
    timeout: { minutes: 10 },
    fn: async () => {
      logger.info('Metering: running hourly cost snapshot');
      const knex = (await database.getClient()) as unknown as Knex;

      const pruned = await pruneOldSnapshots(knex, config.retentionDays);
      if (pruned > 0) {
        logger.debug(`Metering: pruned ${pruned} old snapshots`);
      }

      const credentials = await auth.getOwnServiceCredentials();

      const { items } = await catalog.getEntities(
        { filter: [{ kind: 'Component' }], fields: ['metadata'] },
        { credentials },
      );

      const annotated = (items as ComponentEntity[]).filter(
        e => e.metadata.annotations?.[ANNOTATION_KUBERNETES_NAMESPACE],
      );

      logger.info(
        `Metering: snapshotting ${annotated.length} annotated entities`,
      );

      for (const entity of annotated) {
        const namespace =
          entity.metadata.annotations![ANNOTATION_KUBERNETES_NAMESPACE];
        const deployment =
          entity.metadata.annotations?.[ANNOTATION_KUBERNETES_ID] ||
          entity.metadata.name;
        const entityRef = `component:${entity.metadata.namespace ?? 'default'}/${entity.metadata.name}`;

        if (snapshotCache.has(entityRef)) continue;

        try {
          const metrics = await prometheusClient.getMetrics(
            namespace,
            deployment,
            1,
          );
          const result = costCalculator.calculate(
            entityRef,
            namespace,
            deployment,
            metrics,
          );

          await insertSnapshot(knex, {
            entityRef: result.entityRef,
            namespace: result.namespace,
            deployment: result.deployment,
            cpuCores: result.cpuCores,
            memGiB: result.memGiB,
            hourlyCost: result.hourlyCost,
            gpuCount: result.gpuCount,
            gpuCost: result.gpuCostPerHour,
          });

          snapshotCache.set(entityRef, true);
        } catch (err) {
          logger.warn(
            `Metering: failed to snapshot ${entityRef}: ${String(err)}`,
          );
        }
      }
    },
  });
}
