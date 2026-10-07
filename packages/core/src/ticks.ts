// SPDX-License-Identifier: AGPL-3.0-or-later

/** Number of decimal places needed to represent `tickSize` exactly (max 10). */
export function tickDecimals(tickSize: number): number {
  assertTickSize(tickSize);
  for (let d = 0; d <= 10; d++) {
    const scaled = tickSize * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d;
  }
  return 10;
}

export function assertTickSize(tickSize: number): void {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new RangeError(`tickSize must be a positive finite number, got ${tickSize}`);
  }
}

/** Convert an integer tick count into a clean decimal price. */
export function ticksToPrice(
  ticks: number,
  tickSize: number,
  decimals = tickDecimals(tickSize),
): number {
  return Number((ticks * tickSize).toFixed(decimals));
}

export function isOnTickGrid(price: number, tickSize: number): boolean {
  const q = price / tickSize;
  return Math.abs(q - Math.round(q)) < 1e-6;
}
