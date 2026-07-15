import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { Knex } from 'knex';
import { createRouter } from './router';
import { createSnapshotScheduler } from './snapshotScheduler';
import { runMigrations } from './database';
import { meteringConfigSchema } from './types';

const meteringPlugin = createBackendPlugin({
  pluginId: 'metering',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        catalog: catalogServiceRef,
      },
      async init({ httpRouter, logger, config, database, scheduler, auth, catalog }) {
        const rawConfig = config.getOptionalConfig('metering');
        if (!rawConfig) {
          logger.warn(
            'Metering plugin: no config found under "metering". Plugin is disabled.',
          );
          return;
        }

        const parseResult = meteringConfigSchema.safeParse({
          prometheusUrl: rawConfig.getString('prometheusUrl'),
          bearerToken: rawConfig.getOptionalString('bearerToken'),
          chargeMode: rawConfig.getOptionalString('chargeMode') ?? 'max',
          windowHours: rawConfig.getOptionalNumber('windowHours') ?? 24,
          retentionDays: rawConfig.getOptionalNumber('retentionDays') ?? 90,
          rollupAfterDays: rawConfig.getOptionalNumber('rollupAfterDays') ?? 30,
          costModel: {
            cpuCostPerCorePerHour: rawConfig
              .getConfig('costModel')
              .getNumber('cpuCostPerCorePerHour'),
            memoryCostPerGBPerHour: rawConfig
              .getConfig('costModel')
              .getNumber('memoryCostPerGBPerHour'),
            gpuCostPerGpuPerHour:
              rawConfig
                .getConfig('costModel')
                .getOptionalNumber('gpuCostPerGpuPerHour') ?? 0,
          },
        });

        if (!parseResult.success) {
          throw new Error(
            `Metering plugin: invalid config — ${parseResult.error.message}`,
          );
        }

        const meteringConfig = parseResult.data;

        // Run DB schema creation
        const knex = (await database.getClient()) as unknown as Knex;
        await runMigrations(knex);
        logger.info('Metering plugin: database ready');

        // Start hourly cost snapshot scheduler
        createSnapshotScheduler(
          meteringConfig,
          logger,
          scheduler,
          database,
          catalog,
          auth,
        );

        // Mount REST router under /api/metering
        const router = createRouter(meteringConfig, logger, knex);
        httpRouter.use(router);
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });

        logger.info(
          `Metering plugin started. Prometheus: ${meteringConfig.prometheusUrl}`,
        );
      },
    });
  },
});

export default meteringPlugin;
