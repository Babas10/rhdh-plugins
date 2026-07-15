import { MeteringConfig, CostResult, ChargeMode } from './types';
import { PrometheusMetrics } from './prometheusClient';

function resolveBillableValue(
  usage: number,
  request: number,
  limit: number,
  mode: ChargeMode,
): number {
  switch (mode) {
    case 'requests':
      return request;
    case 'limits':
      return limit;
    case 'max':
      return Math.max(usage, request);
    case 'usage':
    default:
      return usage;
  }
}

export class CostCalculator {
  private readonly config: MeteringConfig;

  constructor(config: MeteringConfig) {
    this.config = config;
  }

  calculate(
    entityRef: string,
    namespace: string,
    deployment: string,
    metrics: PrometheusMetrics,
  ): CostResult {
    const { cpuCostPerCorePerHour, memoryCostPerGBPerHour } =
      this.config.costModel;
    const mode = this.config.chargeMode;

    const billableCpu = resolveBillableValue(
      metrics.cpuCores,
      metrics.cpuRequestCores,
      metrics.cpuLimitCores,
      mode,
    );
    const billableMem = resolveBillableValue(
      metrics.memGiB,
      metrics.memRequestGiB,
      metrics.memLimitGiB,
      mode,
    );

    const cpuCostPerHour = billableCpu * cpuCostPerCorePerHour;
    const memoryCostPerHour = billableMem * memoryCostPerGBPerHour;
    const gpuCostPerHour = metrics.gpuCount * (this.config.costModel.gpuCostPerGpuPerHour ?? 0);

    return {
      entityRef,
      namespace,
      deployment,
      chargeMode: mode,
      cpuCores: metrics.cpuCores,
      memGiB: metrics.memGiB,
      gpuCount: metrics.gpuCount,
      gpuMemGiB: metrics.gpuMemGiB,
      cpuCostPerHour,
      memoryCostPerHour,
      gpuCostPerHour,
      hourlyCost: cpuCostPerHour + memoryCostPerHour + gpuCostPerHour,
      cpuRequestCores: metrics.cpuRequestCores,
      memRequestGiB: metrics.memRequestGiB,
      cpuLimitCores: metrics.cpuLimitCores,
      memLimitGiB: metrics.memLimitGiB,
      replicaCount: metrics.replicaCount,
      windowHours: this.config.windowHours,
      sampledAt: new Date().toISOString(),
    };
  }
}
