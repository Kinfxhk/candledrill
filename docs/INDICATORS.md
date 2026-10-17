# CandleDrill built-in indicators

CandleDrill includes common technical indicators for visual reference while practising.
They are computed from the **bars already in hand** — the chart uses revealed bars only,
and a macro condition uses the same functions on the bar prefix up to the cursor.
No formula reads a later bar to draw an earlier point.

Indicator choices are a local UI preference (`candledrill.indicators.v2` in
`localStorage`). They are not part of the session file. An older fixed-slot list under
`candledrill.indicators` is merged onto the previous defaults the first time it is loaded.

## Catalog

Each chart pane has an **Indicators** button. The panel has:

- a typeahead search (name and aliases such as `sma`, `orb`, `stoch`)
- category chips: Trend, Volatility, Momentum, Volume, Session
- an active list: show or hide, edit parameters, remove
- **Add**, which creates another instance

SMA and EMA are not limited to three slots. Adding “SMA 200” creates another line.
At most **12** non-volume overlays are visible at once; further ones are added hidden.

## Available indicators

### Overlay (on the price chart)

| Indicator       | Default                            | Formula                                                                                                                                                                                                 |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Volume          | on                                 | Histogram of bar volume                                                                                                                                                                                 |
| SMA             | 20 (slots 9 / 20 / 50 ship hidden) | Simple moving average of the selected source                                                                                                                                                            |
| EMA             | 21 (slots 9 / 21 / 50 ship hidden) | Exponential moving average, alpha = 2/(period+1), seeded with the SMA                                                                                                                                   |
| Bollinger Bands | 20, 2                              | Middle = SMA; upper/lower = middle ± stdDev × sample standard deviation                                                                                                                                 |
| Session VWAP    | –                                  | Cumulative Σ(typical × volume) / Σ(volume), reset each exchange trading day                                                                                                                             |
| ORB             | 30 minutes                         | High and low of bars whose exchange-session minute is inside the window. The level updates while the window is open, then stays frozen for the rest of that trading day. A later bar does not widen it. |
| Donchian        | 20                                 | Upper = highest high of the last `period` bars (including the current bar); lower = lowest low; middle = midpoint                                                                                       |

### Pane (below the price chart)

| Indicator  | Default  | Formula                                                                                                                                           |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| RSI        | 14       | Wilder's RSI                                                                                                                                      |
| MACD       | 12/26/9  | MACD = EMA(fast) − EMA(slow); signal = EMA of MACD; histogram = difference                                                                        |
| ATR        | 14       | Wilder's average true range                                                                                                                       |
| Stochastic | 14, 3, 3 | %K from the close inside the high-low range, smoothed, then %D = SMA of %K. A zero range is 50.                                                   |
| ADX        | 14       | Wilder +DI / −DI / ADX. The seed is the sum of the first `period` DM and TR values; the first ADX is the average of the first `period` DX values. |

## Honesty note

An indicator line changes as new bars are revealed, the same way it would in real time.
These are educational overlays, not trade recommendations.

Opening-range levels need a trading-day boundary (`day start` on the session, plus the UTC
offset). The built-in `SYNTH-` series is a short continuous sample and may not show a clean
session open. For a Globex-shaped practice file, import
[`PRACTICE-NQ-GLOBEX`](https://github.com/Kinfxhk/candledrill-synth-samples)
as described in the README. That file is not shipped in this repository.

## Out of scope

- Supertrend, Ichimoku
- ZigZag (it repaints)
- Order-flow, footprint, volume profile
- Pine Script import
- Live or broker order routing

Simulated condition lists and backtests are documented in [MACRO.md](MACRO.md). They are
not alerts and they do not place live orders.
