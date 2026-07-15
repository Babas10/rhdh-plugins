import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Typography } from '@material-ui/core';
import { Progress } from '@backstage/core-components';
import { CostHistoryPoint } from '../../api';
import { formatUsd } from '../common/format';

// Each chart point carries both the total monthly cost (left axis, the main
// signal the user asked for) and the average hourly cost (right axis, for
// context). In the ≤ 60-day raw-hourly view, totalCost equals hourlyCost.
interface ChartPoint {
  ts: number;
  hourlyCost: number;   // avg $/hr for this period
  totalCost: number;    // sum of all hourly costs (= total $ for the month)
}

/**
 * When the time range exceeds 60 days, aggregate all data points into one
 * value per calendar month. Both the monthly total and the average hourly
 * rate are computed so each Y-axis has meaningful data.
 *
 * For ranges ≤ 60 days the raw hourly points are returned unchanged with
 * totalCost === hourlyCost (no meaningful "monthly total" for a single hour).
 */
function maybeAggregate(points: CostHistoryPoint[], rangeDays: number): ChartPoint[] {
  if (rangeDays <= 60) {
    return points.map(p => ({
      ts: new Date(p.sampledAt).getTime(),
      hourlyCost: p.hourlyCost,
      totalCost: p.hourlyCost,
    }));
  }

  // Group by calendar month. For rollup rows there is exactly one point per
  // month and totalCost already holds the actual monthly sum — pass it through
  // directly. For recent hourly rows there are many points per month and we
  // sum their totalCost values to get the true monthly total.
  const byMonth = new Map<string, {
    totalCostSum: number;
    hourlySum: number;
    count: number;
    ts: number;
  }>();

  for (const p of points) {
    const ts = new Date(p.sampledAt).getTime();
    const d = new Date(ts);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const existing = byMonth.get(key);
    if (existing) {
      existing.totalCostSum += p.totalCost;
      existing.hourlySum    += p.hourlyCost;
      existing.count        += 1;
    } else {
      byMonth.set(key, {
        totalCostSum: p.totalCost,
        hourlySum:    p.hourlyCost,
        count:        1,
        ts: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
      });
    }
  }

  return Array.from(byMonth.values())
    .map(({ totalCostSum, hourlySum, count, ts }) => ({
      ts,
      hourlyCost: hourlySum / count,
      totalCost:  totalCostSum,
    }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Compute monthly tick positions spanning the data range.
 * Returns the first-of-month timestamps (UTC midnight) within [min, max].
 * Falls back to weekly ticks for ranges under 60 days.
 */
function computeTicks(points: { ts: number }[]): number[] {
  if (points.length === 0) return [];
  const min = points[0].ts;
  const max = points[points.length - 1].ts;
  const rangeDays = (max - min) / 86_400_000;

  const ticks: number[] = [];

  if (rangeDays > 60) {
    // One tick per calendar month
    const d = new Date(min);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() <= max) {
      ticks.push(d.getTime());
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  } else {
    // One tick per week
    const d = new Date(min);
    d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() <= max) {
      ticks.push(d.getTime());
      d.setUTCDate(d.getUTCDate() + 7);
    }
  }

  return ticks;
}

function formatTick(ts: number, rangeDays: number): string {
  const d = new Date(ts);
  if (rangeDays > 60) {
    return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTooltipLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

interface Props {
  historyState: {
    value?: CostHistoryPoint[];
    loading: boolean;
    error?: Error;
  };
}

export function CostTrendChart({ historyState }: Props) {
  if (historyState.loading) {
    return <Progress />;
  }

  if (historyState.error) {
    return (
      <Typography variant="body2" color="error">
        Failed to load cost history.
      </Typography>
    );
  }

  const points = historyState.value ?? [];

  if (points.length === 0) {
    return (
      <Typography variant="body2" color="textSecondary">
        No cost history yet — snapshots are written hourly and will appear
        here after the first cycle.
      </Typography>
    );
  }

  const timestamps = points.map(p => new Date(p.sampledAt).getTime());
  const rangeDays = timestamps.length > 1
    ? (timestamps[timestamps.length - 1] - timestamps[0]) / 86_400_000
    : 1;

  const data = maybeAggregate(points, rangeDays);
  const ticks = computeTicks(data);
  const isMonthly = rangeDays > 60;

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 100, bottom: 4, left: 8 }}>
        {/* No CartesianGrid — clean look with solid axes only */}
        <XAxis
          dataKey="ts"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          ticks={ticks}
          tickFormatter={(ts: number) => formatTick(ts, rangeDays)}
          tick={{ fontSize: 13, fill: '#fff' }}
          axisLine={{ stroke: '#fff' }}
          tickLine={{ stroke: '#fff' }}
        />

        {/* Left Y-axis — total monthly cost (primary signal) */}
        <YAxis
          yAxisId="left"
          tick={{ fontSize: 13, fill: '#fff' }}
          tickFormatter={(v: number) =>
            isMonthly ? formatUsd(v, 0) : formatUsd(v, 4)
          }
          width={76}
          axisLine={{ stroke: '#fff' }}
          tickLine={{ stroke: '#fff' }}
          label={{
            value: isMonthly ? 'Monthly ($)' : '$/hr',
            angle: -90,
            position: 'insideLeft',
            offset: 14,
            style: { fontSize: 13, fontWeight: 600, fill: '#fff' },
          }}
        />

        {/* Right Y-axis — avg hourly cost (context, only in monthly view) */}
        {isMonthly && (
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 13, fill: '#fff' }}
            tickFormatter={(v: number) => formatUsd(v, 4)}
            width={96}
            axisLine={{ stroke: '#fff' }}
            tickLine={{ stroke: '#fff' }}
            label={{
              value: 'Avg $/hr',
              angle: 90,
              position: 'insideRight',
              offset: 72,
              style: { fontSize: 13, fontWeight: 600, fill: '#fff' },
            }}
          />
        )}

        <Tooltip
          formatter={((value: number, name: string) => {
            if (name === 'Monthly cost') return [formatUsd(value, 2), name];
            return [`${formatUsd(value, 4)}/hr`, name];
          }) as any}
          labelFormatter={((ts: number) => formatTooltipLabel(ts)) as any}
        />

        {/* Primary line — total monthly cost on left axis */}
        <Line
          yAxisId="left"
          type="monotone"
          dataKey="totalCost"
          name="Monthly cost"
          stroke="#1976d2"
          strokeWidth={2}
          dot={{ r: 3, fill: '#1976d2' }}
          activeDot={{ r: 5 }}
        />

        {/* Secondary line — avg hourly rate on right axis (monthly view only) */}
        {isMonthly && (
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="hourlyCost"
            name="Avg $/hr"
            stroke="#388e3c"
            strokeWidth={1.5}
            strokeDasharray="5 3"
            dot={false}
            activeDot={{ r: 4 }}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
