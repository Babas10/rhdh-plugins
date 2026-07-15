import Router from 'express-promise-router';
import { Request, Response, Router as ExpressRouter } from 'express';
import { LoggerService } from '@backstage/backend-plugin-api';
import { LRUCache } from 'lru-cache';
import { Knex } from 'knex';
import { PrometheusClient } from './prometheusClient';
import { CostCalculator } from './costCalculator';
import { MeteringConfig, CostResult } from './types';
import { getHistory, getAvailableMonths, getMonthlyReport } from './database';

function parsePosInt(val: unknown, fallback: number): number {
  const n = parseInt(String(val), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function createRouter(
  config: MeteringConfig,
  logger: LoggerService,
  knex: Knex,
): ExpressRouter {
  const router = Router();

  const prometheusClient = new PrometheusClient(
    config.prometheusUrl,
    logger,
    config.bearerToken,
  );
  const costCalculator = new CostCalculator(config);

  // 5-minute LRU cache keyed on namespace+deployment+window
  const cache = new LRUCache<string, CostResult>({
    max: 200,
    ttl: 5 * 60 * 1000,
  });

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  router.get('/cost', async (req: Request, res: Response) => {
    const { namespace, deployment, entityRef } = req.query as Record<
      string,
      string
    >;

    if (!namespace || !deployment) {
      res.status(400).json({
        error:
          'Missing required query params: namespace and deployment are required',
      });
      return;
    }

    const effectiveEntityRef = entityRef || `component:default/${deployment}`;
    const windowHours = parsePosInt(req.query.windowHours, config.windowHours);
    const cacheKey = `${namespace}/${deployment}/${windowHours}`;

    const cached = cache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const metrics = await prometheusClient.getMetrics(
      namespace,
      deployment,
      windowHours,
    );
    const result = costCalculator.calculate(
      effectiveEntityRef,
      namespace,
      deployment,
      metrics,
    );

    cache.set(cacheKey, result);
    res.json(result);
  });

  router.get('/cost/history', async (req: Request, res: Response) => {
    const { entityRef } = req.query as Record<string, string>;

    if (!entityRef) {
      res.status(400).json({ error: 'Missing required query param: entityRef' });
      return;
    }

    const days = parsePosInt(req.query.days, 30);
    const history = await getHistory(knex, entityRef, days);

    res.json(
      history.map(s => ({
        sampledAt: s.sampledAt.toISOString(),
        hourlyCost: s.hourlyCost,
        totalCost: s.totalCost,
        cpuCores: s.cpuCores,
        memGiB: s.memGiB,
      })),
    );
  });

  // Story 7.1 — months that have data, newest first
  router.get('/available-months', async (req: Request, res: Response) => {
    const { entityRef } = req.query as Record<string, string>;
    if (!entityRef) {
      res.status(400).json({ error: 'Missing required query param: entityRef' });
      return;
    }
    const months = await getAvailableMonths(knex, entityRef);
    res.json(months);
  });

  // Story 7.2 — daily breakdown + monthly summary for a given month
  router.get('/report', async (req: Request, res: Response) => {
    const { entityRef, month } = req.query as Record<string, string>;
    if (!entityRef || !month) {
      res.status(400).json({ error: 'Missing required query params: entityRef and month' });
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(month)) {
      res.status(400).json({ error: 'month must be in YYYY-MM format' });
      return;
    }
    const report = await getMonthlyReport(knex, entityRef, month);
    res.json(report);
  });

  return router;
}
