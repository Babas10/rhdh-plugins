import React from 'react';
import { Grid, Typography } from '@material-ui/core';
import { InfoCard, Progress, ResponseErrorPanel } from '@backstage/core-components';
import { useMeteringData } from '../common/useMeteringData';
import { MeteringAnnotationGuard } from '../common/MeteringAnnotationGuard';
import { formatUsd } from '../common/format';

/**
 * Compact cost summary shown on the entity Overview tab. Full detail (KPIs,
 * resource efficiency, usage averages) lives on the dedicated Metering tab —
 * see MeteringTabContent.
 */
export function MeteringSummaryCard() {
  const { namespace, deployment, costState } = useMeteringData(24);

  if (!namespace) {
    return (
      <InfoCard title="Cost">
        <MeteringAnnotationGuard />
      </InfoCard>
    );
  }

  if (costState.error) {
    return (
      <InfoCard title="Cost">
        <ResponseErrorPanel error={costState.error} />
      </InfoCard>
    );
  }

  if (costState.loading || !costState.value) {
    return (
      <InfoCard title="Cost">
        <Progress />
      </InfoCard>
    );
  }

  const cost = costState.value;

  return (
    <InfoCard title="Cost" subheader={`${namespace}/${deployment}`}>
      <Grid container spacing={2}>
        <Grid item xs={6}>
          <Typography variant="h5">{formatUsd(cost.hourlyCost)}</Typography>
          <Typography variant="caption" color="textSecondary">
            per hour (24h avg)
          </Typography>
        </Grid>
        <Grid item xs={6}>
          <Typography variant="h5">
            {formatUsd(cost.hourlyCost * 24 * 30, 2)}
          </Typography>
          <Typography variant="caption" color="textSecondary">
            per month (projected)
          </Typography>
        </Grid>
      </Grid>
    </InfoCard>
  );
}
