import { LoggerService } from '@backstage/backend-plugin-api';
import * as fs from 'fs';

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

export interface PrometheusMetrics {
  cpuCores: number;
  memGiB: number;
  cpuRequestCores: number;
  memRequestGiB: number;
  cpuLimitCores: number;
  memLimitGiB: number;
  gpuCount: number;
  gpuMemGiB: number;
  replicaCount: number;
}

function buildPodSelector(namespace: string, deployment: string): string {
  // Matches pods created by a Deployment — e.g. my-app-7d8f9b-xxxxx
  return `namespace="${namespace}",pod=~"${deployment}-[a-z0-9]+-[a-z0-9]+",container!=""`;
}

export class PrometheusClient {
  private readonly baseUrl: string;
  private readonly logger: LoggerService;
  private readonly bearerToken?: string;

  constructor(baseUrl: string, logger: LoggerService, bearerToken?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.logger = logger;
    this.bearerToken = bearerToken;
  }

  private getToken(): string {
    // An explicitly configured token (e.g. for local dev against a
    // port-forwarded OpenShift Prometheus) always takes precedence over the
    // in-cluster service account token.
    if (this.bearerToken) {
      return this.bearerToken;
    }
    try {
      return fs.readFileSync(SA_TOKEN_PATH, 'utf8').trim();
    } catch {
      // Running locally without a mounted service account — unauthenticated
      return '';
    }
  }

  private async query(promql: string): Promise<number> {
    const token = this.getToken();
    const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(promql)}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(
        `Prometheus query failed (${res.status}): ${await res.text()}`,
      );
    }

    const body = (await res.json()) as {
      status: string;
      data: { result: Array<{ value: [number, string] }> };
    };

    if (body.status !== 'success') {
      throw new Error(`Prometheus returned non-success status: ${body.status}`);
    }

    const result = body.data.result;
    if (!result || result.length === 0) {
      return 0;
    }

    return parseFloat(result[0].value[1]) || 0;
  }

  async getMetrics(
    namespace: string,
    deployment: string,
    windowHours: number,
  ): Promise<PrometheusMetrics> {
    const sel = buildPodSelector(namespace, deployment);
    const window = `${windowHours}h`;

    this.logger.debug(
      `Metering: querying Prometheus for ${namespace}/${deployment} over ${window}`,
    );

    const podSel = `namespace="${namespace}",pod=~"${deployment}-[a-z0-9]+-[a-z0-9]+"`;

    const [cpuCores, memBytes, cpuRequestCores, memRequestBytes, cpuLimitCores, memLimitBytes, gpuUtil, gpuMemBytes, replicaCount] =
      await Promise.all([
        this.query(
          `sum(rate(container_cpu_usage_seconds_total{${sel}}[${window}]))`,
        ),
        this.query(`sum(container_memory_working_set_bytes{${sel}})`),
        this.query(
          `sum(kube_pod_container_resource_requests{${podSel},resource="cpu"})`,
        ),
        this.query(
          `sum(kube_pod_container_resource_requests{${podSel},resource="memory"})`,
        ),
        this.query(
          `sum(kube_pod_container_resource_limits{${podSel},resource="cpu"})`,
        ),
        this.query(
          `sum(kube_pod_container_resource_limits{${podSel},resource="memory"})`,
        ),
        // NVIDIA DCGM Exporter — returns 0 gracefully when the exporter is absent
        this.query(
          `sum(DCGM_FI_DEV_GPU_UTIL{namespace="${namespace}",pod=~"${deployment}-.+"}) / 100`,
        ),
        this.query(
          `sum(DCGM_FI_DEV_FB_USED{namespace="${namespace}",pod=~"${deployment}-.+"}) * 1048576`,
        ),
        this.query(
          `kube_deployment_status_replicas{namespace="${namespace}",deployment="${deployment}"}`,
        ),
      ]);

    return {
      cpuCores,
      memGiB: memBytes / 1024 ** 3,
      cpuRequestCores,
      memRequestGiB: memRequestBytes / 1024 ** 3,
      cpuLimitCores,
      memLimitGiB: memLimitBytes / 1024 ** 3,
      gpuCount: gpuUtil,
      gpuMemGiB: gpuMemBytes / 1024 ** 3,
      replicaCount: Math.round(replicaCount),
    };
  }
}
