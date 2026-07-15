import React, { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Drawer,
  Box,
  Typography,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  CircularProgress,
  Divider,
  Grid,
  IconButton,
  Tooltip,
} from '@material-ui/core';
import GetAppIcon from '@material-ui/icons/GetApp';
import CloseIcon from '@material-ui/icons/Close';
import AssessmentIcon from '@material-ui/icons/Assessment';
import InfoOutlinedIcon from '@material-ui/icons/InfoOutlined';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from 'recharts';
import { useApi } from '@backstage/core-plugin-api';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  meteringApiRef,
  MonthlyReport,
  AvailableMonth,
} from '../../api';
import { formatUsd } from '../common/format';

// ── helpers ───────────────────────────────────────────────────────────────────

function formatMonth(yyyyMm: string): string {
  const [year, month] = yyyyMm.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Extracts a human-readable name from a Backstage entityRef.
 *  "component:default/resource-burner" → "resource-burner" */
function friendlyName(entityRef: string): string {
  return entityRef.includes('/') ? entityRef.split('/').pop()! : entityRef;
}

function exportCsv(report: MonthlyReport, entityRef: string): void {
  const hasGpu = report.dailyRows.some(r => r.avgGpuCount > 0);

  const header = [
    'Date', 'Avg CPU (cores)', 'Avg Mem (GiB)',
    ...(hasGpu ? ['Avg GPU'] : []),
    'Daily Cost ($)', 'Data Points',
  ];

  const rows = report.dailyRows.map(r => [
    r.date,
    r.avgCpuCores.toFixed(3),
    r.avgMemGiB.toFixed(3),
    ...(hasGpu ? [r.avgGpuCount.toFixed(3)] : []),
    r.dailyCost.toFixed(2),
    String(r.sampleCount),
  ]);

  const summary = report.summary
    ? [
        [],
        ['MONTHLY SUMMARY'],
        ['Total Cost ($)',    report.summary.totalCost.toFixed(2)],
        ['Avg Daily Cost ($)', report.summary.avgDailyCost.toFixed(2)],
        ['Peak Day',          report.summary.peakDate ?? 'N/A'],
        ['Peak Day Cost ($)', report.summary.peakCost.toFixed(2)],
        ['Avg CPU (cores)',   report.summary.avgCpuCores.toFixed(3)],
        ['Avg Mem (GiB)',     report.summary.avgMemGiB.toFixed(3)],
        ['Data Points',       String(report.summary.sampleCount)],
      ]
    : [];

  const csv = [header, ...rows, ...summary]
    .map(row => row.map(v => `"${v}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `metering-report_${friendlyName(entityRef)}_${report.month}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportPdf(report: MonthlyReport, entityRef: string): void {
  const doc = new jsPDF();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const name = friendlyName(entityRef);
  const hasGpu = report.dailyRows.some(r => r.avgGpuCount > 0);

  // ── Header ────────────────────────────────────────────────────────────
  doc.setFillColor(25, 118, 210);
  doc.rect(0, 0, pageW, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(`Cost Report — ${formatMonth(report.month)}`, margin, 12);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`${name}  ·  ${entityRef}`, margin, 22);
  doc.setTextColor(0);

  let y = 38;

  // ── KPI cards ─────────────────────────────────────────────────────────
  if (report.summary) {
    // Two rows of 3 cards:
    //   Row 1 (financial): Total Cost | Avg Daily Cost | Peak Day
    //   Row 2 (resources): Avg CPU    | Avg Memory     | Data Points
    const row1: Array<{ label: string; value: string; sub?: string }> = [
      { label: 'Total Cost',     value: `$${report.summary.totalCost.toFixed(2)}` },
      { label: 'Avg Daily Cost', value: `$${report.summary.avgDailyCost.toFixed(2)}` },
      { label: 'Peak Day',
        value: report.summary.peakDate ? report.summary.peakDate.slice(5) : 'N/A',
        sub:   report.summary.peakDate ? `$${report.summary.peakCost.toFixed(2)}` : undefined },
    ];
    const row2: Array<{ label: string; value: string; sub?: string }> = [
      { label: 'Avg CPU',      value: `${report.summary.avgCpuCores.toFixed(3)}`, sub: 'cores' },
      { label: 'Avg Memory',   value: `${report.summary.avgMemGiB.toFixed(3)}`,   sub: 'GiB' },
      { label: 'Data Points',  value: String(report.summary.sampleCount) },
    ];

    const colCount = 3;
    const gap = 3;
    const cardW = (pageW - margin * 2 - gap * (colCount - 1)) / colCount;
    const cardH = 26;

    const drawCardRow = (
      cards: Array<{ label: string; value: string; sub?: string }>,
      rowY: number,
      fillColor: [number, number, number],
      textColor: [number, number, number],
    ) => {
      cards.forEach((card, i) => {
        const x = margin + i * (cardW + gap);
        doc.setFillColor(fillColor[0], fillColor[1], fillColor[2]);
        doc.setDrawColor(25, 118, 210);
        doc.roundedRect(x, rowY, cardW, cardH, 2, 2, 'FD');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(textColor[0], textColor[1], textColor[2]);
        const valY = card.sub ? rowY + 9 : rowY + 12;
        doc.text(card.value, x + cardW / 2, valY, { align: 'center' });

        if (card.sub) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9);
          doc.setTextColor(textColor[0], textColor[1], textColor[2]);
          doc.text(card.sub, x + cardW / 2, rowY + 16, { align: 'center' });
        }

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(100);
        doc.text(card.label, x + cardW / 2, rowY + cardH - 3, { align: 'center' });
      });
    };

    // Row 1 — financial (blue accent)
    drawCardRow(row1, y, [240, 246, 255], [25, 118, 210]);
    y += cardH + 4;

    // Row 2 — resource (teal accent)
    drawCardRow(row2, y, [240, 250, 244], [56, 142, 60]);
    y += cardH + 10;

    doc.setTextColor(0);
  }

  // ── Daily breakdown table ─────────────────────────────────────────────
  if (report.dailyRows.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Daily Breakdown', margin, y);
    doc.setFont('helvetica', 'normal');
    y += 4;

    const head = [
      'Date',
      'CPU (cores)',
      'Mem (GiB)',
      ...(hasGpu ? ['GPU'] : []),
      'Daily Cost ($)',
      'Data Points',
    ];

    const body = report.dailyRows.map(r => [
      r.date,
      r.avgCpuCores.toFixed(3),
      r.avgMemGiB.toFixed(3),
      ...(hasGpu ? [r.avgGpuCount.toFixed(3)] : []),
      r.dailyCost.toFixed(2),   // 2 decimal places — consistent with summary
      String(r.sampleCount),
    ]);

    // Column count varies based on GPU visibility
    const numericColStart = 1;
    const colCount = head.length;
    const numericStyles: Record<number, object> = {};
    for (let c = numericColStart; c < colCount; c++) {
      numericStyles[c] = { halign: 'right' };
    }

    autoTable(doc, {
      startY: y,
      head: [head],
      body,
      styles: { fontSize: 9, cellPadding: 2 },
      headStyles: { fillColor: [25, 118, 210], fontStyle: 'bold', halign: 'center' },
      alternateRowStyles: { fillColor: [248, 250, 255] },
      columnStyles: numericStyles,
    });
  }

  doc.save(`metering-report_${name}_${report.month}.pdf`);
}

// ── ReportPreview ─────────────────────────────────────────────────────────────

function ReportPreview({ report }: { report: MonthlyReport }) {
  const chartData = report.dailyRows.map(r => ({
    date: r.date.slice(5), // "MM-DD"
    cost: r.dailyCost,
  }));

  return (
    <Box>
      {report.summary && (
        <>
          <Typography variant="subtitle2" gutterBottom>Monthly Summary</Typography>
          <Grid container spacing={2} style={{ marginBottom: 16 }}>
            {[
              { label: 'Total Cost',     value: formatUsd(report.summary.totalCost, 2) },
              { label: 'Avg Daily Cost', value: formatUsd(report.summary.avgDailyCost, 2) },
              { label: 'Peak Day',       value: report.summary.peakDate
                  ? `${report.summary.peakDate} (${formatUsd(report.summary.peakCost, 2)})`
                  : 'N/A' },
              { label: 'Avg CPU',        value: `${report.summary.avgCpuCores.toFixed(3)} cores` },
              { label: 'Avg Memory',     value: `${report.summary.avgMemGiB.toFixed(3)} GiB` },
              { label: 'Samples',        value: String(report.summary.sampleCount) },
            ].map(({ label, value }) => (
              <Grid item xs={6} key={label}>
                <Typography variant="caption" color="textSecondary" display="block">{label}</Typography>
                <Typography variant="body2"><strong>{value}</strong></Typography>
              </Grid>
            ))}
          </Grid>
          <Divider style={{ marginBottom: 16 }} />
        </>
      )}

      {chartData.length > 0 && (
        <>
          <Typography variant="subtitle2" gutterBottom>Daily Cost</Typography>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => formatUsd(v, 2)}
                width={56}
              />
              <RechartsTooltip formatter={((v: number) => [formatUsd(v, 4), 'Daily cost']) as any} />
              <Bar dataKey="cost" fill="#1976d2" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <Divider style={{ margin: '16px 0' }} />
        </>
      )}

      {report.dailyRows.length > 0 ? (
        <>
          <Typography variant="subtitle2" gutterBottom>Daily Breakdown</Typography>
          <Box style={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell align="right">CPU (cores)</TableCell>
                  <TableCell align="right">Mem (GiB)</TableCell>
                  <TableCell align="right">Daily Cost</TableCell>
                  <TableCell align="right">Samples</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {report.dailyRows.map(r => (
                  <TableRow key={r.date} hover>
                    <TableCell>{r.date}</TableCell>
                    <TableCell align="right">{r.avgCpuCores.toFixed(3)}</TableCell>
                    <TableCell align="right">{r.avgMemGiB.toFixed(3)}</TableCell>
                    <TableCell align="right">{formatUsd(r.dailyCost, 4)}</TableCell>
                    <TableCell align="right">{r.sampleCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </>
      ) : (
        <Typography variant="body2" color="textSecondary">
          Daily breakdown not available — this month has been rolled up into a
          monthly aggregate. Only the summary is shown.
        </Typography>
      )}
    </Box>
  );
}

// ── ReportDrawer ──────────────────────────────────────────────────────────────

interface Props {
  entityRef: string;
}

export function ReportDrawer({ entityRef }: Props) {
  const meteringApi = useApi(meteringApiRef);

  const [open, setOpen]               = useState(false);
  const [months, setMonths]           = useState<AvailableMonth[]>([]);
  const [loadingMonths, setLoadingMonths] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState('');
  const [report, setReport]           = useState<MonthlyReport | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [error, setError]             = useState<string | null>(null);

  const loadMonths = useCallback(async () => {
    setLoadingMonths(true);
    setError(null);
    try {
      const data = await meteringApi.getAvailableMonths({ entityRef });
      setMonths(data);
      if (data.length > 0) setSelectedMonth(data[0].month);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingMonths(false);
    }
  }, [meteringApi, entityRef]);

  useEffect(() => {
    if (open) loadMonths();
  }, [open, loadMonths]);

  const generateReport = async () => {
    if (!selectedMonth) return;
    setLoadingReport(true);
    setReport(null);
    setError(null);
    try {
      const data = await meteringApi.getMonthlyReport({ entityRef, month: selectedMonth });
      setReport(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingReport(false);
    }
  };

  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<AssessmentIcon />}
        onClick={() => setOpen(true)}
      >
        Download Report
      </Button>

      <Drawer anchor="right" open={open} onClose={() => setOpen(false)}>
        <Box style={{ width: 560, padding: 24, overflowY: 'auto' }}>
          {/* Header */}
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Monthly Cost Report</Typography>
            <IconButton size="small" onClick={() => setOpen(false)}>
              <CloseIcon />
            </IconButton>
          </Box>

          {/* Month picker */}
          <Box display="flex" alignItems="center" style={{ gap: 12, marginBottom: 20 }}>
            <FormControl variant="outlined" size="small" style={{ minWidth: 200 }}>
              <InputLabel>Month</InputLabel>
              <Select
                value={selectedMonth}
                onChange={e => { setSelectedMonth(e.target.value as string); setReport(null); }}
                label="Month"
                disabled={loadingMonths}
              >
                {months.map(m => (
                  <MenuItem key={m.month} value={m.month}>
                    <Box display="flex" alignItems="center" style={{ gap: 6 }}>
                      {formatMonth(m.month)}
                      {!m.hasDailyData && (
                        <Tooltip title="Daily breakdown unavailable — hourly data for this month has been aggregated into a monthly total. Only the summary is shown.">
                          <InfoOutlinedIcon style={{ fontSize: 14, color: '#888' }} />
                        </Tooltip>
                      )}
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Button
              variant="contained"
              color="primary"
              size="small"
              onClick={generateReport}
              disabled={!selectedMonth || loadingReport}
            >
              {loadingReport ? <CircularProgress size={16} /> : 'Generate'}
            </Button>
          </Box>

          {error && (
            <Typography variant="body2" color="error" style={{ marginBottom: 16 }}>
              {error}
            </Typography>
          )}

          {loadingMonths && (
            <Box display="flex" justifyContent="center" mt={4}>
              <CircularProgress />
            </Box>
          )}

          {/* Report preview */}
          {report && (
            <>
              <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                <Typography variant="subtitle1">
                  {formatMonth(report.month)}
                </Typography>
                <Box style={{ display: 'flex', gap: 8 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<GetAppIcon />}
                    onClick={() => exportCsv(report, entityRef)}
                  >
                    CSV
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<GetAppIcon />}
                    onClick={() => exportPdf(report, entityRef)}
                  >
                    PDF
                  </Button>
                </Box>
              </Box>

              <ReportPreview report={report} />
            </>
          )}

          {!report && !loadingReport && !loadingMonths && months.length === 0 && (
            <Typography variant="body2" color="textSecondary">
              No cost data available yet. Snapshots are written hourly.
            </Typography>
          )}
        </Box>
      </Drawer>
    </>
  );
}
