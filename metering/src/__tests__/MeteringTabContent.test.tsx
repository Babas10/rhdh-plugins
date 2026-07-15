import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import { MeteringTabContent } from '../components/MeteringTabContent';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { meteringApiRef, CostResult, CostHistoryPoint } from '../api';
import { Entity } from '@backstage/catalog-model';

const mockEntity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'test-app',
    namespace: 'default',
    annotations: {
      'backstage.io/kubernetes-namespace': 'test-ns',
      'backstage.io/kubernetes-id': 'test-deployment',
    },
  },
  spec: { type: 'service', lifecycle: 'production', owner: 'team-a' },
};

const mockEntityNoAnnotation: Entity = {
  ...mockEntity,
  metadata: { ...mockEntity.metadata, annotations: {} },
};

const mockCostResult: CostResult = {
  entityRef: 'component:default/test-app',
  namespace: 'test-ns',
  deployment: 'test-deployment',
  chargeMode: 'max',
  cpuCores: 0.5,
  memGiB: 1.0,
  gpuCount: 0,
  gpuMemGiB: 0,
  cpuCostPerHour: 0.024,
  memoryCostPerHour: 0.006,
  gpuCostPerHour: 0,
  hourlyCost: 0.03,
  cpuRequestCores: 1.0,
  memRequestGiB: 2.0,
  cpuLimitCores: 2.0,
  memLimitGiB: 4.0,
  replicaCount: 2,
  windowHours: 24,
  sampledAt: new Date().toISOString(),
};

const mockHistory: CostHistoryPoint[] = [
  {
    sampledAt: new Date().toISOString(),
    hourlyCost: 0.03,
    cpuCores: 0.5,
    memGiB: 1.0,
  },
];

function buildApi(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    getCost: jest.fn().mockResolvedValue(mockCostResult),
    getCostHistory: jest.fn().mockResolvedValue(mockHistory),
    ...overrides,
  };
}

function renderTab(entity: Entity, api = buildApi()) {
  return renderInTestApp(
    <TestApiProvider apis={[[meteringApiRef, api]]}>
      <EntityProvider entity={entity}>
        <MeteringTabContent />
      </EntityProvider>
    </TestApiProvider>,
  );
}

describe('MeteringTabContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows annotation guard message when kubernetes-namespace is absent', async () => {
    await renderTab(mockEntityNoAnnotation);
    expect(
      screen.getAllByText(/backstage\.io\/kubernetes-namespace/).length,
    ).toBeGreaterThan(0);
  });

  it('renders side-by-side KPIs after loading', async () => {
    await renderTab(mockEntity);

    await waitFor(() => {
      expect(screen.getByText('Hourly Cost')).toBeTruthy();
    });
    expect(screen.getByText('Daily Cost')).toBeTruthy();
    expect(screen.getByText('Monthly Cost')).toBeTruthy();
    expect(screen.getByText('Replicas')).toBeTruthy();
  });

  it('renders daily/weekly/monthly usage averages instead of charts', async () => {
    await renderTab(mockEntity);

    await waitFor(() => {
      expect(screen.getByText('Daily Average')).toBeTruthy();
    });
    expect(screen.getByText('Weekly Average')).toBeTruthy();
    expect(screen.getByText('Monthly Average')).toBeTruthy();
  });

  it('renders cost breakdown card with CPU, Memory and GPU tiles', async () => {
    await renderTab(mockEntity);

    await waitFor(() => {
      expect(screen.getByText('Cost Breakdown')).toBeTruthy();
    });
    expect(screen.getByText('CPU $/hr')).toBeTruthy();
    expect(screen.getByText('Memory $/hr')).toBeTruthy();
    expect(screen.getByText('GPU $/hr')).toBeTruthy();
  });

  it('shows real GPU tile when gpuCount > 0', async () => {
    const gpuApi = buildApi({
      getCost: jest.fn().mockResolvedValue({
        ...mockCostResult,
        gpuCount: 1.5,
        gpuMemGiB: 8,
        gpuCostPerHour: 3.72,
        hourlyCost: mockCostResult.hourlyCost + 3.72,
      }),
    });

    await renderTab(mockEntity, gpuApi);

    await waitFor(() => {
      expect(screen.getByText('GPU $/hr')).toBeTruthy();
    });
    expect(screen.getAllByText(/1\.50 GPU-equiv/).length).toBeGreaterThan(0);
  });

  it('displays error message when API fails', async () => {
    const failingApi = buildApi({
      getCost: jest.fn().mockRejectedValue(new Error('Prometheus unreachable')),
    });

    await renderTab(mockEntity, failingApi);

    await waitFor(() => {
      expect(screen.getAllByText(/Prometheus unreachable/i).length).toBeGreaterThan(0);
    });
  });
});
