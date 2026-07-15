import React, { useState } from 'react';
import {
  Box,
  Button,
  ButtonGroup,
  Grid,
  Typography,
} from '@material-ui/core';
import AttachMoneyIcon from '@material-ui/icons/AttachMoney';
import TodayIcon from '@material-ui/icons/Today';
import DateRangeIcon from '@material-ui/icons/DateRange';
import LayersIcon from '@material-ui/icons/Layers';
import DeveloperBoardIcon from '@material-ui/icons/DeveloperBoard';
import MemoryIcon from '@material-ui/icons/Memory';
import { InfoCard, Progress, ResponseErrorPanel } from '@backstage/core-components';
import { useMeteringData } from '../common/useMeteringData';
import { MeteringAnnotationGuard } from '../common/MeteringAnnotationGuard';
import { formatUsd } from '../common/format';
import { KpiTile } from './KpiTile';
import { UtilizationBar } from './UtilizationBar';
import { AverageCard } from './AverageCard';
import { CostDonut } from './CostDonut';
import { CostTrendChart } from './CostTrendChart';
import { ReportDrawer } from './ReportDrawer';

type WindowOption = { label: string; hours: number };
const WINDOW_OPTIONS: WindowOption[] = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

/**
 * Full-page content for the entity's dedicated "Metering" tab — mirrors the
 * pattern used by the Kubernetes and ArgoCD plugins (a full-width tab rather
 * than everything crammed into the Overview card).
 */
export function MeteringTabContent() {
  const [windowHours, setWindowHours] = useState(24);
  const { namespace, deployment, entityRef, costState, historyState, averages } =
    useMeteringData(windowHours);

  if (!namespace) {
    return <MeteringAnnotationGuard />;
  }

  if (costState.error) {
    return <ResponseErrorPanel error={costState.error} />;
  }

  const cost = costState.value;

  return (
    <Grid container spacing={3} direction="column">
      <Grid item>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Typography variant="subtitle1" color="textSecondary">
            {namespace}/{deployment}
          </Typography>
          <ReportDrawer entityRef={entityRef} />
          <ButtonGroup size="small" aria-label="cost averaging window" style={{ marginLeft: 8 }}>
            {WINDOW_OPTIONS.map(opt => (
              <Button
                key={opt.hours}
                variant={windowHours === opt.hours ? 'contained' : 'outlined'}
                color={windowHours === opt.hours ? 'primary' : 'default'}
                onClick={() => setWindowHours(opt.hours)}
              >
                {opt.label}
              </Button>
            ))}
          </ButtonGroup>
        </Box>
      </Grid>

      {costState.loading || !cost ? (
        <Grid item>
          <Progress />
        </Grid>
      ) : (
        <>
          <Grid item>
            <Grid container spacing={2}>
              <Grid item xs={6} sm={3}>
                <KpiTile
                  icon={<AttachMoneyIcon fontSize="small" color="action" />}
                  label="Hourly Cost"
                  value={formatUsd(cost.hourlyCost)}
                  sub={`avg over ${windowHours}h · billed on ${cost.chargeMode}`}
                />
              </Grid>
              <Grid item xs={6} sm={3}>
                <KpiTile
                  icon={<TodayIcon fontSize="small" color="action" />}
                  label="Daily Cost"
                  value={formatUsd(cost.hourlyCost * 24, 3)}
                  sub="projected"
                />
              </Grid>
              <Grid item xs={6} sm={3}>
                <KpiTile
                  icon={<DateRangeIcon fontSize="small" color="action" />}
                  label="Monthly Cost"
                  value={formatUsd(cost.hourlyCost * 24 * 30, 2)}
                  sub="projected"
                />
              </Grid>
              <Grid item xs={6} sm={3}>
                <KpiTile
                  icon={<LayersIcon fontSize="small" color="action" />}
                  label="Replicas"
                  value={String(cost.replicaCount)}
                  sub="running"
                />
              </Grid>
            </Grid>
          </Grid>

          <Grid item>
            <InfoCard title="Resource Efficiency">
              <UtilizationBar
                label="CPU"
                used={cost.cpuCores}
                total={cost.cpuRequestCores}
                unit="cores"
              />
              <UtilizationBar
                label="Memory"
                used={cost.memGiB}
                total={cost.memRequestGiB}
                unit="GiB"
              />
              {cost.gpuCount > 0 && (
                <UtilizationBar
                  label="GPU"
                  used={cost.gpuCount}
                  total={cost.gpuCount}
                  unit="GPU-equiv"
                />
              )}
            </InfoCard>
          </Grid>

          <Grid item>
            <InfoCard title="Cost Breakdown">
              <CostDonut cost={cost} />
              <Grid container spacing={2} style={{ marginTop: 8 }}>
                <Grid item xs={12} sm={4}>
                  <KpiTile
                    icon={<DeveloperBoardIcon fontSize="small" color="action" />}
                    label="CPU $/hr"
                    value={formatUsd(cost.cpuCostPerHour)}
                    sub={`${((cost.cpuCostPerHour / (cost.hourlyCost || 1)) * 100).toFixed(0)}% of total`}
                  />
                </Grid>
                <Grid item xs={12} sm={4}>
                  <KpiTile
                    icon={<MemoryIcon fontSize="small" color="action" />}
                    label="Memory $/hr"
                    value={formatUsd(cost.memoryCostPerHour)}
                    sub={`${((cost.memoryCostPerHour / (cost.hourlyCost || 1)) * 100).toFixed(0)}% of total`}
                  />
                </Grid>
                <Grid item xs={12} sm={4}>
                  <KpiTile
                    icon={<AttachMoneyIcon fontSize="small" color="action" />}
                    label="GPU $/hr"
                    value={cost.gpuCount > 0 ? formatUsd(cost.gpuCostPerHour) : '—'}
                    sub={cost.gpuCount > 0 ? `${cost.gpuCount.toFixed(2)} GPU-equiv` : 'No GPU workload'}
                  />
                </Grid>
              </Grid>
            </InfoCard>
          </Grid>
        </>
      )}

      <Grid item>
        <InfoCard title="6-Month Cost Trend">
          <CostTrendChart historyState={historyState} />
        </InfoCard>
      </Grid>

      <Grid item>
        <Typography variant="h6" gutterBottom>
          Usage Averages
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={4}>
            <AverageCard title="Daily Average" average={averages.daily} />
          </Grid>
          <Grid item xs={12} sm={4}>
            <AverageCard title="Weekly Average" average={averages.weekly} />
          </Grid>
          <Grid item xs={12} sm={4}>
            <AverageCard title="Monthly Average" average={averages.monthly} />
          </Grid>
        </Grid>
      </Grid>
    </Grid>
  );
}
