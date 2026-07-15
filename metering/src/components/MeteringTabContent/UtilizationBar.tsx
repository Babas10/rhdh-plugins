import React from 'react';
import { Box, LinearProgress, Typography } from '@material-ui/core';
import { utilizationPct } from '../common/format';

interface UtilizationBarProps {
  label: string;
  used: number;
  total: number;
  unit: string;
}

export function UtilizationBar({ label, used, total, unit }: UtilizationBarProps) {
  const pct = utilizationPct(used, total);
  const hasRequest = total > 0;

  return (
    <Box mb={2}>
      <Box display="flex" justifyContent="space-between">
        <Typography variant="body2">{label}</Typography>
        <Typography variant="body2" color="textSecondary">
          {hasRequest
            ? `${used.toFixed(3)} / ${total.toFixed(3)} ${unit} (${pct.toFixed(0)}%)`
            : `${used.toFixed(3)} ${unit} (no request set)`}
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={hasRequest ? pct : 0}
        color={pct > 90 ? 'secondary' : 'primary'}
      />
    </Box>
  );
}
