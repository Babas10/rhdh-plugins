import React from 'react';
import { Card, CardContent, Typography } from '@material-ui/core';
import { UsageAverage } from '../common/useMeteringData';
import { formatCores, formatGiB, formatUsd } from '../common/format';

interface AverageCardProps {
  title: string;
  average?: UsageAverage;
}

export function AverageCard({ title, average }: AverageCardProps) {
  return (
    <Card variant="outlined" style={{ height: '100%' }}>
      <CardContent>
        <Typography variant="subtitle2" gutterBottom>
          {title}
        </Typography>
        {average ? (
          <>
            <Typography variant="body2">
              CPU: {formatCores(average.avgCpuCores)}
            </Typography>
            <Typography variant="body2">
              Memory: {formatGiB(average.avgMemGiB)}
            </Typography>
            <Typography variant="body2">
              Cost: {formatUsd(average.avgHourlyCost)}/hr
            </Typography>
            <Typography variant="caption" color="textSecondary">
              based on {average.sampleCount} hourly sample
              {average.sampleCount === 1 ? '' : 's'}
            </Typography>
          </>
        ) : (
          <Typography variant="body2" color="textSecondary">
            Not enough historical data yet — snapshots are collected hourly.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
