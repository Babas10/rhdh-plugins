export function formatUsd(value: number, decimals = 4): string {
  return `$${value.toFixed(decimals)}`;
}

export function formatCores(value: number): string {
  return `${value.toFixed(3)} cores`;
}

export function formatGiB(value: number): string {
  return `${value.toFixed(3)} GiB`;
}

export function utilizationPct(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, (used / total) * 100);
}
