# Simulated macro

A macro is a JSON document. On each **closed** bar it checks an ordered list of rules.
The first enabled rule whose conditions are all true can send **one simulated market order**
with a stop and a target. The order goes through `sessionPlaceOrder` and later bars go
through `stepSession` / `processBar`. Fill model v3 is unchanged: next-bar open for market
orders, stop-first when a bar touches both stop and target, keep-open at the end of the data.

This is educational. It does not connect to a broker, exchange, or alert webhook. It does
not run Pine. The manual order ticket stays on the right-hand column.

The builder is the bottom **Macro** tab: a four-step wizard (rules and conditions, entry
and exit, how to run, result). Working orders are the bottom **Working orders** tab. The
chart **Macro** button opens the wizard. **Run backtest** stays off until a name, quantity,
an enabled rule, and a stop and target are set, and it lists what is still missing.

A blind session cannot run or arm a macro. The new-session form says so while Blind
practice is checked, including right after demo data is generated with that box still on.
Opening a hidden blind session shows the same notice before you open the Macro tab.

Hide the wizard with `localStorage.setItem('candledrill.feature.macro', '0')` and bring it
back from the **Macro** button on the chart. The flag defaults to on.

## When a condition is checked

The engine looks at bars `0 .. cursor` only. The cursor bar is already closed. A market
order placed there fills on a **later** bar, using the normal slippage. Bracket prices are
measured from that bar's close (the same reference the ticket's risk preview uses) and
rounded to the tick. They are not rewritten to the fill price.

While a blind session is still hidden, backtest and watch both refuse to run.

## Rules

- Conditions on one rule are **AND**.
- Lower `priority` wins when several rules are true on the same bar. Ties keep document order.
- `onePositionOnly` defaults to **true**: no new entry while a position or a working entry exists.
- Optional `maxTradesPerDay` counts entries whose time falls on the current exchange day.
- Optional `flattenAtSessionEnd` sends a flatten (existing flatten semantics) when the next
  bar belongs to a new trading day and a position is already open. The flatten fills on that
  next bar.

## Conditions (schema v1)

| type                   | Meaning                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `price_vs_ma`          | Close is above or below an SMA or EMA.                                                                                                                                                                           |
| `ma_cross`             | Fast MA crosses the slow MA on this bar.                                                                                                                                                                         |
| `orb_break`            | After the opening window, close is beyond the frozen opening range. `up` / `down` / `either`. The window is `minutes` after `dayStartMinutes` in exchange-local time. The breakout bar is not part of the range. |
| `flat_only`            | No position and no working entry.                                                                                                                                                                                |
| `time_window`          | Exchange-local minute of the civil day, `startMinute` inclusive, `endMinute` exclusive. If `start > end` the window crosses midnight. If they are equal, the whole day matches.                                  |
| `rsi`                  | Wilder RSI above, below, or crossing a level.                                                                                                                                                                    |
| `macd`                 | Histogram sign, or MACD crossing its signal line.                                                                                                                                                                |
| `bb`                   | Close beyond a band, or the bar's range touching it.                                                                                                                                                             |
| `donchian_break`       | Close beyond the prior `period` bars' high or low (the current bar is excluded).                                                                                                                                 |
| `stoch_cross`          | Smoothed %K crosses %D. Optional level filters the previous %K (oversold / overbought).                                                                                                                          |
| `adx`                  | ADX above or below a level, optionally requiring +DI above −DI or the reverse.                                                                                                                                   |
| `day_of_week`          | Exchange-local weekday of the bar open, 0 = Sunday … 6 = Saturday.                                                                                                                                               |
| `min_bars_since_entry` | At least this many bars since the last entry order.                                                                                                                                                              |

Presets in the panel insert these objects; you can still edit the numbers.

## Exits

| Stop                             | Target                                         |
| -------------------------------- | ---------------------------------------------- |
| `ticks`                          | `ticks`                                        |
| `atr_mult` (ATR 14)              | `atr_mult`                                     |
| `percent` of the reference close | `percent`                                      |
|                                  | `rr` — target distance = stop distance × value |

If ATR is not ready yet, an ATR exit is skipped for that bar.

## Backtest

`POST /api/sessions/:id/macro-run` with `{ macro, mode: "to_end" | "n_bars", count?, from: "start" | "cursor" }`.

The server runs the loop in-process. It does **not** call the 5,000-step HTTP limit, does
**not** save the session, and does **not** return bars or trade timestamps. The response is
`computeStats` plus signal and bar counts, and the risk notice.

`from: "start"` rebuilds a fresh session at the first bar (a research copy).
`from: "cursor"` continues a copy of the current book. Either way the practice cursor stays
put, so the chart does not reveal the future. The **numbers can include later bars**. That
is why the result card says so, and why a hidden blind session is rejected.

Built-in `SYNTH-` data is a short generated series. ORB checks in the test suite use a
fixed session-shaped fixture (30 one-minute bars inside the window, then a close break).
A longer Globex-like CSV lives in
[`candledrill-synth-samples`](https://github.com/Kinfxhk/candledrill-synth-samples)
(`PRACTICE-NQ-GLOBEX`) and is not vendored here. Import it yourself if you want a full
session open on the chart.

## Watch

**Arm watch**, then Play. The play timer steps **one** bar at a time and, after each
revealed close, may call the normal order API. Step 10 while armed only evaluates the bar
you land on. History sent to the browser is capped at 50,000 bars; watch evaluates that
tail, not a bar the browser no longer holds.

Disarm before you want the play button to batch bars again. Placing a manual order does
not disarm by itself; one-position mode simply will not add another entry.

## Not included

Live brokerage, webhooks, Pine, ZigZag, order flow, or a second fill engine.
