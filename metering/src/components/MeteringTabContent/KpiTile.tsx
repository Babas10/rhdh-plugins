import React from 'react';
import { Box, Card, CardContent, Typography } from '@material-ui/core';

interface KpiTileProps {
  icon?: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}

export function KpiTile({ icon, label, value, sub }: KpiTileProps) {
  return (
    <Card variant="outlined" style={{ height: '100%' }}>
      <CardContent>
        <Box display="flex" alignItems="center" style={{ gap: 6 }}>
          {icon}
          <Typography variant="overline" color="textSecondary">
            {label}
          </Typography>
        </Box>
        <Typography variant="h4" style={{ marginTop: 4 }}>
          {value}
        </Typography>
        {sub && (
          <Typography variant="caption" color="textSecondary">
            {sub}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
