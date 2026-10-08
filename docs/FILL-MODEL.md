# Fill model and simulation policies

CandleDrill simulates orders on **OHLC bars**. A bar records only its open, high, low
and close, so the order of prices inside it is unknown. This page lists the rules
CandleDrill uses, so every practice result can be explained and reproduced. It is not
a model of a real exchange.

Current versions: **engine 0.1.1, fill model v2.** Both appear in every HTML report, in
session JSON exports (`simulationPolicy`) and at `GET /api/health`. The fill model
version changes whenever a rule that can change a fill price, a fill time or a rule
outcome changes.

| Policy key          | Value                       | Meaning                                                                                        |
| ------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `fillTiming`        | `next-bar-or-later`         | An order can only fill on a bar revealed after the bar it was placed on.                       |
| `sameBarPolicy`     | `stop-first`                | If one bar touches both the stop-loss and the take-profit, the stop-loss fills first.          |
| `limitPolicy`       | `touch`                     | A limit order fills when the bar touches its price (not only when it trades through).          |
| `gapPolicy`         | `fill-at-open`              | An order already crossed when it becomes active fills at the bar open, never outside the bar.  |
| `bracketReference`  | `absolute-price`            | Stop-loss and take-profit are absolute prices.                                                 |
| `bracketModify`     | `atomic-revalidate`         | An edit re-checks the whole bracket and is applied in full or rejected. Every edit is logged.  |
| `ruleEvaluation`    | `bar-close`                 | Practice rules are checked at each bar close.                                                  |
| `profitTargetBasis` | `net-after-exit-costs`      | The profit target counts only after estimated exit commission and slippage.                    |
| `lossRuleBasis`     | `closing-equity`            | The daily loss limit and trailing drawdown use mark-to-market closing equity.                  |
| `endOfDataPolicy`   | `keep-open`                 | At the end of the data an open position stays open, valued at the last close.                  |
| `riskBasis`         | `all-entry-fills-with-stop` | R uses the stop-loss risk of every entry fill. It is N/A when any entry fill had no stop-loss. |

## Order fills

- **Market** orders fill at the next bar's open plus adverse slippage.
- **Limit** orders fill at their price when the bar touches it. If the bar opens beyond
  the price, they fill at the open (price improvement). Limit fills have no slippage.
- **Stop** orders trigger when the bar trades at or through the stop price. They fill at
  the stop price, or at the open if the bar gaps through it, plus adverse slippage.
- Within one bar, orders crossed at the open fill first. After that, stop-type orders
  fill before limit-type orders.
- Every fill lies within the bar's low–high range. The only exception is the configured
  adverse slippage on market and stop fills. A property-based test checks this.

## Bracket orders (entry + stop-loss + take-profit)

The children are created when the entry fills. On the entry bar they follow the same
trigger rules as any working order, applied only to the part of the bar known to come
**after** the entry:

- **Entry at the open.** The whole bar follows the entry. If the open has already
  crossed the stop-loss or take-profit (a gap), the child fills at the open. Otherwise
  the stop-loss fills if touched, and then the take-profit fills if touched.
- **Entry inside the bar at price P.** Only P is known to follow the entry. A child
  already crossed at P exits at P (plus stop slippage). The stop-loss may still fill at
  its price if the bar reached it, because the order of the high and low is unknown and
  the conservative assumption is the stop. The take-profit may **not** fill on that bar,
  because the favourable extreme may have happened before the entry.

Example (tick 1, no costs): previous close 100, market buy with stop-loss 98, next bar
O95 H96 L94 C95. The entry fills at 95. The stop is already crossed, so the position
exits at 95. Fill model v1 (0.1.0) wrongly reported an exit at 98, above the bar's
high.

### Modifying orders

- **Entry orders.** You may change the price (limit/stop), the stop-loss and the
  take-profit in one request. With `shiftBracket`, the existing stop-loss and
  take-profit move by the same distance as the price. The result is validated like a new
  order: for a buy, the stop-loss must be below and the take-profit above the entry
  price, mirrored for a sell. Market entries are checked against the last close.
  Invalid combinations are rejected and nothing changes.
- **Stop-loss / take-profit children** accept a new price only. It must not already be
  marketable against the last close: for a long, the stop-loss stays below it and the
  take-profit above it, mirrored for a short. To exit at the next open, use Flatten.
- Every accepted change is appended to `state.trading.modifications` with its time and
  its before/after prices.

## Practice rules

- Rules are evaluated at each bar close. Intrabar breaches are not detected.
- **Profit target:** the target is reached when
  `equity − estimated exit costs − starting balance ≥ target`. The estimated exit costs
  are the commission plus the adverse slippage for the open quantity. The position is
  then closed at that close with exactly those costs, so the realized result of a
  passed session is never below the target.
- **Daily loss limit / trailing drawdown:** compared against mark-to-market closing
  equity, before exit costs. On a breach the position is closed at the close, with
  costs.

## End of data

When the replay reaches the last bar:

- working orders are cancelled with the reason `end of data`, because no later bar exists
  to fill them;
- an open position stays open, marked to the last close;
- Flatten and new orders are refused (the API answers 400, and the UI disables Flatten);
- the statistics and the HTML report show the open position and its open P&L separately
  from closed trades.

CandleDrill never invents a "next bar" price. A future option may settle at the last
close with `exitReason: end-of-data`, but it is not implemented in 0.1.1.

## R-multiple

- `initialRisk` = the sum over every entry fill of `|fill price − its stop-loss| × qty ×
point value`. `rMultiple = netPnl / initialRisk`.
- If any entry fill of the trade had no stop-loss, the risk is incomplete. In that case
  `riskComplete` is false, `initialRisk` and `rMultiple` are null, and R is shown as
  **N/A**. Average R only includes trades with complete risk.
- `firstEntryRisk` and `firstEntryR` keep the first entry's own risk and the result
  relative to it, under names that cannot be confused with R. `plannedRisk` is the known
  (stop-protected) part, and `unprotectedQty` is the quantity added without a stop.
- Partial exits do not change the risk basis. A reversal starts a new trade with its own
  basis. Moving a stop after entry does not change the initial risk.

## Model limitations

- Bar-based: no order book, no queue position, no partial fills. Volume is not liquidity.
- Single instrument, net position, integer quantities, a fixed point value per contract
  (futures-style). No currency conversion, fractional quantities or negative prices.
- Commission is per contract per side. Slippage is a fixed number of ticks on market and
  stop fills.
- Times are UTC internally. The trading-day boundary uses a fixed UTC offset; daylight
  saving is not modelled.
- Results of the same data, settings and actions are deterministic. Practice results do
  not predict real trading results.

## What "no look-ahead" covers

The **practice session data path** never sends bars past the replay cursor: session
open, step and jump only return revealed bars. A property-based test checks that
trading results never depend on unrevealed bars.

Two things fall outside that guarantee:

- the **data library** shows a preview of a dataset (by default its most recent 5,000
  bars) before you start a session, and its API can return any bar of a dataset;
- all data and the source code are on your own computer.

So CandleDrill protects you against seeing the future _by accident_. It is not an
anti-cheating system. A blind-practice mode that skips the preview is planned for
v0.2.
