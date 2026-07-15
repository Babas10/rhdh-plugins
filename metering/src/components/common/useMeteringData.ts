import { useEffect, useState } from 'react';
import { useEntity } from '@backstage/plugin-catalog-react';
import { useApi } from '@backstage/core-plugin-api';
import { meteringApiRef, CostResult, CostHistoryPoint } from '../../api';

export const ANNOTATION_K8S_NAMESPACE = 'backstage.io/kubernetes-namespace';
export const ANNOTATION_K8S_ID = 'backstage.io/kubernetes-id';

const DAY_MS = 24 * 60 * 60 * 1000;

interface AsyncState<T> {
  value?: T;
  loading: boolean;
  error?: Error;
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    fn()
      .then(value => !cancelled && setState({ value, loading: false }))
      .catch(error => !cancelled && setState({ loading: false, error }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

export interface UsageAverage {
  sampleCount: number;
  avgCpuCores: number;
  avgMemGiB: number;
  avgHourlyCost: number;
}

function averageOver(
  history: CostHistoryPoint[],
  sinceMs: number,
): UsageAverage | undefined {
  const cutoff = Date.now() - sinceMs;
  const points = history.filter(
    p => new Date(p.sampledAt).getTime() >= cutoff,
  );
  if (!points.length) {
    return undefined;
  }
  const sum = (key: keyof CostHistoryPoint) =>
    points.reduce((acc, p) => acc + (p[key] as number), 0);

  return {
    sampleCount: points.length,
    avgCpuCores: sum('cpuCores') / points.length,
    avgMemGiB: sum('memGiB') / points.length,
    avgHourlyCost: sum('hourlyCost') / points.length,
  };
}

export interface MeteringData {
  namespace?: string;
  deployment: string;
  entityRef: string;
  costState: AsyncState<CostResult>;
  historyState: AsyncState<CostHistoryPoint[]>;
  averages: {
    daily?: UsageAverage;
    weekly?: UsageAverage;
    monthly?: UsageAverage;
  };
}

export function useMeteringData(windowHours: number): MeteringData {
  const { entity } = useEntity();
  const meteringApi = useApi(meteringApiRef);

  const annotations = entity.metadata.annotations ?? {};
  const namespace = annotations[ANNOTATION_K8S_NAMESPACE];
  const deployment = annotations[ANNOTATION_K8S_ID] || entity.metadata.name;
  const entityRef = `${entity.kind.toLowerCase()}:${entity.metadata.namespace ?? 'default'}/${entity.metadata.name}`;

  const costState = useAsync<CostResult>(
    () =>
      meteringApi.getCost({ namespace, deployment, entityRef, windowHours }),
    [namespace, deployment, entityRef, windowHours],
  );

  const historyState = useAsync<CostHistoryPoint[]>(
    () => meteringApi.getCostHistory({ entityRef, days: 180 }),
    [entityRef],
  );

  const history = historyState.value ?? [];

  return {
    namespace,
    deployment,
    entityRef,
    costState,
    historyState,
    averages: {
      daily: averageOver(history, DAY_MS),
      weekly: averageOver(history, 7 * DAY_MS),
      monthly: averageOver(history, 30 * DAY_MS),
    },
  };
}

