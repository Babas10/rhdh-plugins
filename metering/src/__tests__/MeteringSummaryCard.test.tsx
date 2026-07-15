import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import { MeteringSummaryCard } from '../components/MeteringSummaryCard';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { meteringApiRef, CostResult } from '../api';
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

const mockMeteringApi = {
  getCost: jest.fn().mockResolvedValue(mockCostResult),
  getCostHistory: jest.fn().mockResolvedValue([]),
};

function renderCard(entity: Entity, api = mockMeteringApi) {
  return renderInTestApp(
    <TestApiProvider apis={[[meteringApiRef, api]]}>
      <EntityProvider entity={entity}>
        <MeteringSummaryCard />
      </EntityProvider>
    </TestApiProvider>,
  );
}

describe('MeteringSummaryCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows annotation guard message when kubernetes-namespace is absent', async () => {
    await renderCard(mockEntityNoAnnotation);
    expect(
      screen.getAllByText(/backstage\.io\/kubernetes-namespace/).length,
    ).toBeGreaterThan(0);
  });

  it('renders hourly and monthly cost after loading', async () => {
    await renderCard(mockEntity);

    await waitFor(() => {
      expect(screen.getByText('$0.0300')).toBeTruthy();
    });
    expect(screen.getByText(/per month/i)).toBeTruthy();
  });

  it('displays error message when API fails', async () => {
    const failingApi = {
      getCost: jest.fn().mockRejectedValue(new Error('Prometheus unreachable')),
      getCostHistory: jest.fn().mockResolvedValue([]),
    };

    await renderCard(mockEntity, failingApi);

    await waitFor(() => {
      expect(screen.getAllByText(/Prometheus unreachable/i).length).toBeGreaterThan(0);
    });
  });
});
