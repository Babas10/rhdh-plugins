import {
  createApiFactory,
  createApiRef,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/core-plugin-api';

export type ChargeMode = 'usage' | 'requests' | 'limits' | 'max';

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

export interface CostHistoryPoint {
  sampledAt: string;
  hourlyCost: number;
  /** Actual total cost for this period: monthly sum for rollup rows,
   *  equals hourlyCost for raw hourly snapshot rows. */
  totalCost: number;
  cpuCores: number;
  memGiB: number;
}

export interface AvailableMonth {
  month: string;       // "YYYY-MM"
  hasDailyData: boolean;
}

export interface DailyReportRow {
  date: string;
  avgCpuCores: number;
  avgMemGiB: number;
  avgGpuCount: number;
  dailyCost: number;
  sampleCount: number;
}

export interface MonthlyReportSummary {
  totalCost: number;
  avgDailyCost: number;
  peakDate: string | null;
  peakCost: number;
  avgCpuCores: number;
  avgMemGiB: number;
  sampleCount: number;
}

export interface MonthlyReport {
  entityRef: string;
  month: string;
  hasDailyBreakdown: boolean;
  dailyRows: DailyReportRow[];
  summary: MonthlyReportSummary | null;
}

export interface MeteringApi {
  getCost(params: {
    namespace: string;
    deployment: string;
    entityRef: string;
    windowHours?: number;
  }): Promise<CostResult>;

  getCostHistory(params: {
    entityRef: string;
    days?: number;
  }): Promise<CostHistoryPoint[]>;

  getAvailableMonths(params: {
    entityRef: string;
  }): Promise<AvailableMonth[]>;

  getMonthlyReport(params: {
    entityRef: string;
    month: string;
  }): Promise<MonthlyReport>;
}

export const meteringApiRef = createApiRef<MeteringApi>({
  id: 'plugin.metering.service',
});

class MeteringClient implements MeteringApi {
  private readonly discoveryApi: typeof discoveryApiRef.T;
  private readonly fetchApi: typeof fetchApiRef.T;

  constructor(
    discoveryApi: typeof discoveryApiRef.T,
    fetchApi: typeof fetchApiRef.T,
  ) {
    this.discoveryApi = discoveryApi;
    this.fetchApi = fetchApi;
  }

  private async getBaseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('metering');
  }

  async getCost(params: {
    namespace: string;
    deployment: string;
    entityRef: string;
    windowHours?: number;
  }): Promise<CostResult> {
    const base = await this.getBaseUrl();
    const qs = new URLSearchParams({
      namespace: params.namespace,
      deployment: params.deployment,
      entityRef: params.entityRef,
      ...(params.windowHours && { windowHours: String(params.windowHours) }),
    });

    const res = await this.fetchApi.fetch(`${base}/cost?${qs}`);
    if (!res.ok) {
      throw new Error(`Metering API error (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }

  async getCostHistory(params: {
    entityRef: string;
    days?: number;
  }): Promise<CostHistoryPoint[]> {
    const base = await this.getBaseUrl();
    const qs = new URLSearchParams({
      entityRef: params.entityRef,
      ...(params.days && { days: String(params.days) }),
    });

    const res = await this.fetchApi.fetch(`${base}/cost/history?${qs}`);
    if (!res.ok) {
      throw new Error(
        `Metering history API error (${res.status}): ${await res.text()}`,
      );
    }
    return res.json();
  }

  async getAvailableMonths(params: { entityRef: string }): Promise<AvailableMonth[]> {
    const base = await this.getBaseUrl();
    const qs = new URLSearchParams({ entityRef: params.entityRef });
    const res = await this.fetchApi.fetch(`${base}/available-months?${qs}`);
    if (!res.ok) {
      throw new Error(`Metering API error (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }

  async getMonthlyReport(params: { entityRef: string; month: string }): Promise<MonthlyReport> {
    const base = await this.getBaseUrl();
    const qs = new URLSearchParams({ entityRef: params.entityRef, month: params.month });
    const res = await this.fetchApi.fetch(`${base}/report?${qs}`);
    if (!res.ok) {
      throw new Error(`Metering API error (${res.status}): ${await res.text()}`);
    }
    return res.json();
  }
}

export const meteringApiFactory = createApiFactory({
  api: meteringApiRef,
  deps: {
    discoveryApi: discoveryApiRef,
    fetchApi: fetchApiRef,
  },
  factory: ({ discoveryApi, fetchApi }) =>
    new MeteringClient(discoveryApi, fetchApi),
});
