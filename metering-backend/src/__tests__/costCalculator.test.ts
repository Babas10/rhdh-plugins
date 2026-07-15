import { CostCalculator } from '../costCalculator';
import { MeteringConfig } from '../types';

const baseMetrics = {
  cpuCores: 0.5,
  memGiB: 2,
  cpuRequestCores: 1,
  memRequestGiB: 4,
  cpuLimitCores: 2,
  memLimitGiB: 8,
  gpuCount: 0,
  gpuMemGiB: 0,
  replicaCount: 2,
};

function makeConfig(overrides: Partial<MeteringConfig> = {}): MeteringConfig {
  return {
    prometheusUrl: 'http://prometheus:9090',
    chargeMode: 'max',
    windowHours: 24,
    retentionDays: 90,
    costModel: {
      cpuCostPerCorePerHour: 0.048,
      memoryCostPerGBPerHour: 0.006,
    },
    ...overrides,
  };
}

describe('CostCalculator', () => {
  it('charges on max(usage, requests) in max mode — picks requests when higher', () => {
    const calc = new CostCalculator(makeConfig({ chargeMode: 'max' }));
    const result = calc.calculate('component:default/app', 'ns', 'app', baseMetrics);

    // cpuRequest(1) > cpuUsage(0.5) → bill 1 core
    expect(result.cpuCostPerHour).toBeCloseTo(1 * 0.048);
    // memRequest(4) > memUsage(2) → bill 4 GiB
    expect(result.memoryCostPerHour).toBeCloseTo(4 * 0.006);
    expect(result.hourlyCost).toBeCloseTo(1 * 0.048 + 4 * 0.006);
    expect(result.chargeMode).toBe('max');
  });

  it('charges on actual usage in usage mode', () => {
    const calc = new CostCalculator(makeConfig({ chargeMode: 'usage' }));
    const result = calc.calculate('component:default/app', 'ns', 'app', baseMetrics);

    expect(result.cpuCostPerHour).toBeCloseTo(0.5 * 0.048);
    expect(result.memoryCostPerHour).toBeCloseTo(2 * 0.006);
  });

  it('charges on requests in requests mode', () => {
    const calc = new CostCalculator(makeConfig({ chargeMode: 'requests' }));
    const result = calc.calculate('component:default/app', 'ns', 'app', baseMetrics);

    expect(result.cpuCostPerHour).toBeCloseTo(1 * 0.048);
    expect(result.memoryCostPerHour).toBeCloseTo(4 * 0.006);
  });

  it('charges on limits in limits mode', () => {
    const calc = new CostCalculator(makeConfig({ chargeMode: 'limits' }));
    const result = calc.calculate('component:default/app', 'ns', 'app', baseMetrics);

    expect(result.cpuCostPerHour).toBeCloseTo(2 * 0.048);
    expect(result.memoryCostPerHour).toBeCloseTo(8 * 0.006);
  });

  it('charges max(usage, requests) and picks usage when it is higher', () => {
    const calc = new CostCalculator(makeConfig({ chargeMode: 'max' }));
    const result = calc.calculate('component:default/app', 'ns', 'app', {
      ...baseMetrics,
      cpuCores: 1.5,   // usage > request
      cpuRequestCores: 1,
    });

    expect(result.cpuCostPerHour).toBeCloseTo(1.5 * 0.048);
  });

  it('handles zero metrics', () => {
    const calc = new CostCalculator(makeConfig());
    const result = calc.calculate('component:default/idle', 'ns', 'idle', {
      cpuCores: 0,
      memGiB: 0,
      cpuRequestCores: 0,
      memRequestGiB: 0,
      cpuLimitCores: 0,
      memLimitGiB: 0,
      gpuCount: 0,
      gpuMemGiB: 0,
      replicaCount: 0,
    });

    expect(result.hourlyCost).toBe(0);
    expect(result.cpuCostPerHour).toBe(0);
    expect(result.memoryCostPerHour).toBe(0);
    expect(result.gpuCostPerHour).toBe(0);
  });

  it('uses custom cost model rates', () => {
    const calc = new CostCalculator(
      makeConfig({ chargeMode: 'usage', costModel: { cpuCostPerCorePerHour: 1.0, memoryCostPerGBPerHour: 0.1 } }),
    );
    const result = calc.calculate('component:default/app', 'ns', 'app', {
      ...baseMetrics,
      cpuCores: 10,
      memGiB: 100,
    });

    expect(result.hourlyCost).toBeCloseTo(10 * 1.0 + 100 * 0.1);
  });

  it('correctly propagates entity metadata and new fields', () => {
    const calc = new CostCalculator(makeConfig());
    const result = calc.calculate(
      'component:production/web-server',
      'production',
      'web-server',
      baseMetrics,
    );

    expect(result.entityRef).toBe('component:production/web-server');
    expect(result.namespace).toBe('production');
    expect(result.deployment).toBe('web-server');
    expect(result.windowHours).toBe(24);
    expect(result.sampledAt).toBeTruthy();
    expect(result.cpuLimitCores).toBe(baseMetrics.cpuLimitCores);
    expect(result.memLimitGiB).toBe(baseMetrics.memLimitGiB);
  });

  it('projects daily and monthly costs correctly', () => {
    const calc = new CostCalculator(makeConfig({ chargeMode: 'usage' }));
    const result = calc.calculate('component:default/app', 'ns', 'app', {
      ...baseMetrics,
      cpuCores: 1,
      memGiB: 1,
    });

    const daily = result.hourlyCost * 24;
    const monthly = result.hourlyCost * 24 * 30;

    expect(daily).toBeCloseTo((0.048 + 0.006) * 24);
    expect(monthly).toBeCloseTo((0.048 + 0.006) * 24 * 30);
  });

  it('adds GPU cost when gpuCount > 0 and gpuCostPerGpuPerHour is configured', () => {
    const calc = new CostCalculator(
      makeConfig({
        chargeMode: 'usage',
        costModel: { cpuCostPerCorePerHour: 0.048, memoryCostPerGBPerHour: 0.006, gpuCostPerGpuPerHour: 2.0 },
      }),
    );
    const result = calc.calculate('component:default/gpu-app', 'ns', 'gpu-app', {
      ...baseMetrics,
      gpuCount: 1.5,
      gpuMemGiB: 8,
    });

    expect(result.gpuCostPerHour).toBeCloseTo(1.5 * 2.0);
    expect(result.hourlyCost).toBeCloseTo(
      0.5 * 0.048 + 2 * 0.006 + 1.5 * 2.0,
    );
    expect(result.gpuCount).toBe(1.5);
    expect(result.gpuMemGiB).toBe(8);
  });

  it('GPU cost is zero when gpuCostPerGpuPerHour is 0 (default)', () => {
    const calc = new CostCalculator(makeConfig());
    const result = calc.calculate('component:default/app', 'ns', 'app', {
      ...baseMetrics,
      gpuCount: 2,
    });

    expect(result.gpuCostPerHour).toBe(0);
  });
});
