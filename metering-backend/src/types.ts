import { z } from 'zod';

export const chargeModeSchema = z.enum(['usage', 'requests', 'limits', 'max']).default('max');

export type ChargeMode = z.infer<typeof chargeModeSchema>;

export const costModelSchema = z.object({
  cpuCostPerCorePerHour: z.number().positive(),
  memoryCostPerGBPerHour: z.number().positive(),
  gpuCostPerGpuPerHour: z.number().nonnegative().default(0),
});

export const meteringConfigSchema = z
  .object({
    prometheusUrl: z.string().url(),
    bearerToken: z.string().optional(),
    chargeMode: chargeModeSchema,
    windowHours: z.number().positive().default(24),
    retentionDays: z.number().positive().default(90),
    rollupAfterDays: z.number().nonnegative().default(30),
    costModel: costModelSchema,
  })
  .refine(data => data.rollupAfterDays < data.retentionDays, {
    message:
      'rollupAfterDays must be less than retentionDays — otherwise pruneOldSnapshots will hard-delete hourly rows before they reach the rollup cutoff, causing silent data loss with no monthly aggregate fallback',
    path: ['rollupAfterDays'],
  });

export type MeteringConfig = z.infer<typeof meteringConfigSchema>;

export interface CostResult {
  entityRef: string;
  namespace: string;
  deployment: string;
  chargeMode: ChargeMode;
  cpuCores: number;
  memGiB: number;
  gpuCount: number;
  gpuMemGiB: number;
  cpuCostPerHour: number;
  memoryCostPerHour: number;
  gpuCostPerHour: number;
  hourlyCost: number;
  cpuRequestCores: number;
  memRequestGiB: number;
  cpuLimitCores: number;
  memLimitGiB: number;
  replicaCount: number;
  windowHours: number;
  sampledAt: string;
}

export interface MonthlyRollup {
  id: number;
  entityRef: string;
  namespace: string;
  deployment: string;
  monthStart: Date;
  avgCpuCores: number;
  avgMemGiB: number;
  avgGpuCount: number;
  totalCost: number;
  sampleCount: number;
  createdAt: Date;
}

export interface CostSnapshot {
  id: number;
  entityRef: string;
  namespace: string;
  deployment: string;
  cpuCores: number;
  memGiB: number;
  hourlyCost: number;
  /** For monthly rollup rows: the actual sum of all hourly costs for that month.
   *  For raw hourly snapshot rows: equals hourlyCost (cost for that single hour).
   *  Used by the frontend to plot a meaningful "total monthly cost" series. */
  totalCost: number;
  gpuCount: number;
  gpuCost: number;
  sampledAt: Date;
}
