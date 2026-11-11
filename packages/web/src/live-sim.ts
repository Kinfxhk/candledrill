// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Client-side live simulation. Plays a synthetic tick path through bars the
// replay engine has not stepped. Fills and practice rules run in the tick
// engine and stay on this screen; they are not written back to the replay session.

import {
  costModel,
  formingBar,
  generateTickPath,
  stepTick,
  tickCancelOrder,
  tickFlatten,
  tickModifyOrder,
  tickPlaceOrder,
  tickSimFromSession,
  type Bar,
  type OrderChange,
  type OrderRequest,
  type SessionSettings,
  type SessionState,
  type TickSimState,
} from '@candledrill/core';

export function liveSimSeed(datasetId: number, sessionId: number): number {
  return (Math.imul(datasetId + 1, 0x9e3779b9) ^ (sessionId >>> 0)) >>> 0;
}

export class LiveSim {
  state: TickSimState;
  private queue: TickQueue = [];
  private seen: TickQueue = [];
  private bar: Bar | null = null;
  private played = 0;
  private readonly originCursor: number;
  private readonly seed: number;
  private readonly anchorTime: number;

  constructor(session: SessionState, seed: number, anchorTime: number) {
    this.state = tickSimFromSession(session);
    this.originCursor = session.cursor;
    this.seed = seed;
    this.anchorTime = anchorTime;
  }

  get idle(): boolean {
    return this.queue.length === 0;
  }

  get lastTime(): number | undefined {
    return this.seen.at(-1)?.time;
  }

  loadBar(bar: Bar, timeframeSeconds: number, tickSize: number): void {
    this.played += 1;
    this.bar = bar;
    this.seen = [];
    this.queue = generateTickPath({
      bar,
      seed: this.seed,
      barIndex: this.originCursor + this.played,
      timeframeSeconds,
      tickSize,
    });
  }

  /** Apply the next tick. Returns the completed source bar when its path is finished. */
  step(settings: SessionSettings): Bar | null {
    const tick = this.queue.shift();
    if (!tick || !this.bar) return null;
    this.seen.push(tick);
    this.state = stepTick(this.state, tick, costModel(settings), settings);
    if (this.queue.length > 0) return null;
    return formingBar(this.bar.time, this.seen, this.bar.volume);
  }

  /** Candle built only from ticks already played. Null before the first tick of a bar. */
  forming(): Bar | null {
    if (!this.bar || this.seen.length === 0) return null;
    const total = this.seen.length + this.queue.length;
    const volume = total > 0 ? this.bar.volume * (this.seen.length / total) : 0;
    return formingBar(this.bar.time, this.seen, volume);
  }

  place(settings: SessionSettings, req: OrderRequest): void {
    this.state = tickPlaceOrder(this.state, settings, costModel(settings), req, this.mark());
  }

  cancel(orderId: number): void {
    this.state = tickCancelOrder(this.state, orderId);
  }

  modify(settings: SessionSettings, orderId: number, change: OrderChange, time: number): void {
    this.state = tickModifyOrder(this.state, costModel(settings), orderId, change, time);
  }

  flatten(settings: SessionSettings): void {
    this.state = tickFlatten(this.state, settings, costModel(settings), this.mark());
  }

  private mark() {
    return this.seen.at(-1) ?? { time: this.anchorTime, price: this.state.trading.lastClose };
  }
}

type TickQueue = { time: number; price: number }[];
