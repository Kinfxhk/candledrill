// SPDX-License-Identifier: AGPL-3.0-or-later
// Informational ticket estimates. Validation/execution remain in the core engine.
import {
  costModel,
  emptyTrading,
  placeOrder,
  roundToTick,
  sessionEquity,
  workingOrders,
  type OrderRequest,
  type OrderType,
  type SessionSettings,
  type SessionState,
  type Side,
} from '@candledrill/core';

export interface TicketInputs {
  type: OrderType;
  qty: string;
  price: string;
  stopTicks: string;
  targetTicks: string;
}

/** Same rounded bracket references used when the ticket submits an order. */
export function ticketOrder(
  settings: SessionSettings,
  lastClose: number,
  input: TicketInputs,
  side: Side,
): OrderRequest {
  const price =
    input.type === 'market' ? null : roundToTick(Number(input.price), settings.tickSize);
  const reference = price ?? lastClose;
  const dir = side === 'buy' ? 1 : -1;
  return {
    side,
    type: input.type,
    qty: Number(input.qty),
    price,
    stopLoss:
      Number(input.stopTicks) > 0
        ? roundToTick(
            reference - dir * Number(input.stopTicks) * settings.tickSize,
            settings.tickSize,
          )
        : null,
    takeProfit:
      Number(input.targetTicks) > 0
        ? roundToTick(
            reference + dir * Number(input.targetTicks) * settings.tickSize,
            settings.tickSize,
          )
        : null,
  };
}

export type RiskPreview =
  | { unavailable: 'locked' | 'position' | 'pending' | 'stop' | 'invalid' }
  | {
      unavailable: null;
      entry: number;
      stopTicks: number;
      priceRisk: number;
      commission: number;
      slippage: number;
      loss: number;
      equityPercent: number | null;
      netReward: number | null;
      rewardRisk: number | null;
    };

/** No future bars: market assumes last close; limit/stop assumes requested price. */
export function previewRisk(
  settings: SessionSettings,
  state: SessionState,
  input: TicketInputs,
  side: Side,
): RiskPreview {
  if (state.status !== 'active') return { unavailable: 'locked' };
  if (state.trading.position) return { unavailable: 'position' };
  if (workingOrders(state.trading).some((o) => o.role === 'entry'))
    return { unavailable: 'pending' };
  const values = [input.qty, input.stopTicks, ...(input.type === 'market' ? [] : [input.price])];
  if (
    values.some((v) => v.trim() !== '' && (!Number.isFinite(Number(v)) || Number(v) <= 0)) ||
    !input.qty.trim() ||
    (input.type !== 'market' && !input.price.trim()) ||
    (input.targetTicks.trim() !== '' &&
      (!Number.isFinite(Number(input.targetTicks)) || Number(input.targetTicks) <= 0))
  ) {
    return { unavailable: 'invalid' };
  }
  if (!input.stopTicks.trim()) return { unavailable: 'stop' };
  const req = ticketOrder(settings, state.trading.lastClose, input, side);
  const costs = costModel(settings);
  try {
    // Pure validation on an empty ledger: never add an order to the live session.
    placeOrder(emptyTrading(state.trading.lastClose), costs, req, state.cursor, 0);
  } catch {
    return { unavailable: 'invalid' };
  }
  const dir = side === 'buy' ? 1 : -1;
  const reference = req.price ?? state.trading.lastClose;
  const slip = settings.slippageTicks * settings.tickSize;
  const entry =
    input.type === 'limit' ? reference : roundToTick(reference + dir * slip, settings.tickSize);
  const stop = req.stopLoss!;
  const stopExit = roundToTick(stop - dir * slip, settings.tickSize);
  const unit = req.qty * settings.pointValue;
  const entrySlip = (entry - reference) * dir * unit;
  const slippage = entrySlip + (stop - stopExit) * dir * unit;
  // applyFill rounds the per-side commission after multiplying by quantity.
  const commission = 2 * (Math.round(settings.commissionPerContract * req.qty * 1e8) / 1e8);
  const stopTicks = ((reference - stop) * dir) / settings.tickSize;
  const priceRisk = (reference - stop) * dir * unit;
  const loss = priceRisk + commission + slippage;
  const netReward =
    req.takeProfit === null
      ? null
      : (req.takeProfit! - reference) * dir * unit - commission - entrySlip;
  const rewardRisk = netReward === null ? null : netReward / loss;
  if (
    entry <= 0 ||
    stopExit <= 0 ||
    loss <= 0 ||
    [
      entry,
      stopTicks,
      priceRisk,
      commission,
      slippage,
      loss,
      ...(netReward === null ? [] : [netReward, rewardRisk!]),
    ].some((v) => !Number.isFinite(v))
  ) {
    return { unavailable: 'invalid' };
  }
  const equity = sessionEquity(settings, state);
  const percent = (100 * loss) / equity;
  const equityPercent = equity > 0 && Number.isFinite(percent) ? percent : null;
  return {
    unavailable: null,
    entry,
    stopTicks,
    priceRisk,
    commission,
    slippage,
    loss,
    equityPercent,
    netReward,
    rewardRisk,
  };
}
