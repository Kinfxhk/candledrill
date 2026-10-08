// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Versioned, public description of the simulation rules. Reports and exports include this
// object so a result can always be traced back to the exact fill model that produced it.
// See docs/FILL-MODEL.md for the long-form explanation.

/** Version of the core engine (follows the release version). */
export const ENGINE_VERSION = '0.2.0';
/**
 * Version of the fill model. Bumped whenever a rule that can change a fill price, a fill
 * time or a rule outcome changes. v1 = CandleDrill 0.1.0; v2 = 0.1.1 (gap-through bracket
 * children fill at the bar open, atomic bracket modification, net profit-target basis,
 * end-of-data keep-open policy); v3 = 0.2.2 (a limit already at or through the last
 * price is rejected instead of filling at the next open).
 */
export const FILL_MODEL_VERSION = '3';

export interface SimulationPolicy {
  readonly engineVersion: string;
  readonly fillModelVersion: string;
  /** Orders only fill on bars revealed after the bar they were placed on. */
  readonly fillTiming: 'next-bar-or-later';
  /** When one bar touches both the stop-loss and the take-profit, the stop-loss fills first. */
  readonly sameBarPolicy: 'stop-first';
  /** Limit orders fill when touched (not only when traded through). */
  readonly limitPolicy: 'touch';
  /**
   * Orders (including bracket children created on the entry bar) whose price is already
   * crossed when they become active fill at the first executable price: the bar open, or the
   * entry price for an intrabar entry. Never at a price outside what the bar allows.
   */
  readonly gapPolicy: 'fill-at-open';
  /** Stop-loss / take-profit are absolute prices chosen by the user. */
  readonly bracketReference: 'absolute-price';
  /** Modifying an entry or child re-validates the whole bracket; invalid edits are rejected. */
  readonly bracketModify: 'atomic-revalidate';
  /** Practice rules are checked at each bar close. */
  readonly ruleEvaluation: 'bar-close';
  /** The profit target counts only after estimated exit commission and slippage. */
  readonly profitTargetBasis: 'net-after-exit-costs';
  /** Loss rules (daily loss, trailing drawdown) use mark-to-market closing equity. */
  readonly lossRuleBasis: 'closing-equity';
  /**
   * At the end of the data an open position stays open, marked to the last close; working
   * orders are cancelled and flatten is unavailable because no later bar exists.
   */
  readonly endOfDataPolicy: 'keep-open';
  /** R uses the summed stop-loss risk of every entry fill; N/A when any fill had no stop. */
  readonly riskBasis: 'all-entry-fills-with-stop';
}

export const SIMULATION_POLICY: SimulationPolicy = Object.freeze({
  engineVersion: ENGINE_VERSION,
  fillModelVersion: FILL_MODEL_VERSION,
  fillTiming: 'next-bar-or-later',
  sameBarPolicy: 'stop-first',
  limitPolicy: 'touch',
  gapPolicy: 'fill-at-open',
  bracketReference: 'absolute-price',
  bracketModify: 'atomic-revalidate',
  ruleEvaluation: 'bar-close',
  profitTargetBasis: 'net-after-exit-costs',
  lossRuleBasis: 'closing-equity',
  endOfDataPolicy: 'keep-open',
  riskBasis: 'all-entry-fills-with-stop',
});
