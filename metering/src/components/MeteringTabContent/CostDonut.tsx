import React from 'react';
import {
  PieChart,
  Pie,
  Cell,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { CostResult } from '../../api';
import { formatUsd } from '../common/format';
import { Typography } from '@material-ui/core';

interface Slice {
  name: string;
  value: number;
  color: string;
}

interface TooltipState {
  x: number;
  y: number;
  name: string;
  value: number;
}

const SLICE_DEFS = [
  { name: 'CPU',    getVal: (c: CostResult) => c.cpuCostPerHour,    color: '#1976d2' },
  { name: 'Memory', getVal: (c: CostResult) => c.memoryCostPerHour, color: '#388e3c' },
  { name: 'GPU',    getVal: (c: CostResult) => c.gpuCostPerHour,    color: '#f57c00' },
];

interface Props {
  cost: CostResult;
}

export function CostDonut({ cost }: Props) {
  const [tooltip, setTooltip] = React.useState<TooltipState | null>(null);

  const slices: Slice[] = SLICE_DEFS.map(d => ({
    name: d.name,
    value: d.getVal(cost),
    color: d.color,
  })).filter(s => s.value > 0);

  if (slices.length === 0) {
    return (
      <Typography variant="body2" color="textSecondary">
        No cost breakdown available.
      </Typography>
    );
  }

  return (
    <>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie
            data={slices}
            cx="50%"
            cy="50%"
            innerRadius={54}
            outerRadius={80}
            paddingAngle={3}
            dataKey="value"
            nameKey="name"
            onMouseMove={(data: any, _index: any, event: any) => {
              // Recharts 3.x nests slice data under .payload; 2.x has it directly.
              const entry = data?.payload ?? data;
              const name  = entry?.name;
              const value = entry?.value;
              if (name !== undefined && value !== undefined && event) {
                setTooltip({ x: event.clientX, y: event.clientY, name, value });
              }
            }}
            onMouseLeave={() => setTooltip(null)}
          >
            {slices.map(slice => (
              <Cell key={slice.name} fill={slice.color} />
            ))}
          </Pie>
          <Legend
            iconType="circle"
            iconSize={10}
            formatter={(value: string) => (
              <span style={{ fontSize: 12 }}>{value}</span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>

      {/* Follow-cursor tooltip rendered at viewport level to avoid SVG clipping */}
      {tooltip && (
        <div
          style={{
            position: 'fixed',
            left: tooltip.x + 14,
            top: tooltip.y - 12,
            background: '#fff',
            border: '1px solid #e0e0e0',
            borderRadius: 4,
            padding: '6px 10px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        >
          <Typography variant="caption">
            <strong>{tooltip.name}</strong>: {formatUsd(tooltip.value)}/hr
          </Typography>
        </div>
      )}
    </>
  );
}
