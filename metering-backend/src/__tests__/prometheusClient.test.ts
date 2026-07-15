import { PrometheusClient } from '../prometheusClient';
import { mockServices } from '@backstage/backend-test-utils';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makePrometheusResponse(value: string) {
  return {
    status: 'success',
    data: {
      result: [{ metric: {}, value: [Date.now() / 1000, value] }],
    },
  };
}

function makeEmptyPrometheusResponse() {
  return {
    status: 'success',
    data: { result: [] },
  };
}

describe('PrometheusClient', () => {
  const logger = mockServices.logger.mock();
  let client: PrometheusClient;

  beforeEach(() => {
    client = new PrometheusClient('http://prometheus:9090', logger);
    jest.clearAllMocks();
  });

  it('returns parsed metrics from Prometheus', async () => {
    // Each of the 9 queries returns a distinct value
    // (cpu, mem, cpuReq, memReq, cpuLimit, memLimit, gpuUtil, gpuMem, replicas)
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => makePrometheusResponse('0.5') })  // CPU usage
      .mockResolvedValueOnce({ ok: true, json: async () => makePrometheusResponse(String(2 * 1024 ** 3)) })  // Mem bytes → 2 GiB
      .mockResolvedValueOnce({ ok: true, json: async () => makePrometheusResponse('1.0') })  // CPU requests
      .mockResolvedValueOnce({ ok: true, json: async () => makePrometheusResponse(String(4 * 1024 ** 3)) })  // Mem requests
      .mockResolvedValueOnce({ ok: true, json: async () => makePrometheusResponse('2.0') })  // CPU limits
      .mockResolvedValueOnce({ ok: true, json: async () => makePrometheusResponse(String(8 * 1024 ** 3)) })  // Mem limits
      .mockResolvedValueOnce({ ok: true, json: async () => makePrometheusResponse('0') })  // GPU util (no GPU)
      .mockResolvedValueOnce({ ok: true, json: async () => makePrometheusResponse('0') })  // GPU mem (no GPU)
      .mockResolvedValueOnce({ ok: true, json: async () => makePrometheusResponse('3') });  // Replicas

    const metrics = await client.getMetrics('my-ns', 'my-app', 24);

    expect(metrics.cpuCores).toBeCloseTo(0.5);
    expect(metrics.memGiB).toBeCloseTo(2);
    expect(metrics.cpuRequestCores).toBeCloseTo(1.0);
    expect(metrics.memRequestGiB).toBeCloseTo(4);
    expect(metrics.cpuLimitCores).toBeCloseTo(2.0);
    expect(metrics.memLimitGiB).toBeCloseTo(8);
    expect(metrics.gpuCount).toBe(0);
    expect(metrics.gpuMemGiB).toBe(0);
    expect(metrics.replicaCount).toBe(3);
  });

  it('returns zero for empty Prometheus results', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makeEmptyPrometheusResponse(),
    });

    const metrics = await client.getMetrics('empty-ns', 'missing-app', 1);

    expect(metrics.cpuCores).toBe(0);
    expect(metrics.memGiB).toBe(0);
    expect(metrics.cpuRequestCores).toBe(0);
    expect(metrics.replicaCount).toBe(0);
  });

  it('throws on Prometheus HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    await expect(client.getMetrics('ns', 'app', 1)).rejects.toThrow(
      'Prometheus query failed (403)',
    );
  });

  it('encodes namespace and deployment in query URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => makePrometheusResponse('0'),
    });

    await client.getMetrics('my namespace', 'my-app', 5);

    const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain(encodeURIComponent('my namespace'));
  });
});
