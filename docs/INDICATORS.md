# CandleDrill built-in indicators

CandleDrill includes common technical indicators for visual reference while practising.
They are computed from the **bars already in hand** — the chart uses revealed bars only.
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

| Indicator       | Default                            | Formula                                                                                                                                                                                                       |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Volume          | on                                 | Histogram of bar volume                                                                                                                                                                                       |
| SMA             | 20 (slots 9 / 20 / 50 ship hidden) | Simple moving average of the selected source                                                                                                                                                                  |
| EMA             | 21 (slots 9 / 21 / 50 ship hidden) | Exponential moving average, alpha = 2/(period+1), seeded with the SMA                                                                                                                                         |
| Bollinger Bands | 20, 2                              | Middle = SMA; upper/lower = middle ± stdDev × sample standard deviation                                                                                                                                       |
| Session VWAP    | –                                  | Cumulative Σ(typical × volume) / Σ(volume), reset each exchange trading day                                                                                                                                   |
| ORB             | 30 minutes                         | High and low of bars whose exchange-session minute is inside the window. The level updates while the window is open, then stays frozen for the rest of that trading day. A later bar does not widen it.       |
| Donchian        | 20                                 | Upper = highest high of the last `period` bars (including the current bar); lower = lowest low; middle = midpoint                                                                                             |
| Keltner         | EMA 20, ATR 10, ×2                 | Middle = EMA; bands = middle ± multiplier × Wilder ATR                                                                                                                                                        |
| Ichimoku        | 9 / 26 / 52                        | Tenkan, Kijun and Senkou B are high-low midpoints. Senkou spans are shifted forward by the Kijun period and are not drawn past the last bar. Chikou is the close shifted back; the last Kijun bars are blank. |
| SuperTrend      | ATR 10, ×3                         | HL2 ± multiplier × ATR, trailed. The first ATR bar starts on the upper band.                                                                                                                                  |
| Parabolic SAR   | 0.02 / 0.20                        | Wilder stop. Index 0 is blank; it accelerates by the step until price crosses.                                                                                                                                |
| ZigZag          | 5%                                 | Straight segments between pivots confirmed by a reversal of that percent. The live leg stays blank, so a confirmed point does not move.                                                                       |
| Envelope        | SMA 20, 10%                        | Middle = SMA; bands = middle × (1 ± percent/100)                                                                                                                                                              |
| DEMA            | 20                                 | 2 × EMA − EMA(EMA), using the same SMA seed as EMA                                                                                                                                                            |
| TEMA            | 20                                 | 3 × EMA − 3 × EMA(EMA) + EMA(EMA(EMA))                                                                                                                                                                        |
| WMA             | 20                                 | Linear weights; the newest bar weighs `period`                                                                                                                                                                |
| Hull MA         | 16                                 | WMA(2 × WMA(n/2) − WMA(n), round(sqrt(n)))                                                                                                                                                                    |
| VWMA            | 20                                 | Moving average weighted by volume                                                                                                                                                                             |
| VWAP bands      | session                            | Session VWAP plus ±1 and ±2 volume-weighted standard-deviation bands of typical price. Same day reset as VWAP.                                                                                                |
| Std error bands | 20, ×2                             | Linear-regression value at the current bar ± multiplier × standard error                                                                                                                                      |
| Price channel   | 20                                 | Highest high and lowest low of the previous `period` bars, excluding the current bar                                                                                                                          |

### Pane (below the price chart)

| Indicator   | Default  | Formula                                                                                                                                           |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| RSI         | 14       | Wilder's RSI                                                                                                                                      |
| MACD        | 12/26/9  | MACD = EMA(fast) − EMA(slow); signal = EMA of MACD; histogram = difference                                                                        |
| ATR         | 14       | Wilder's average true range                                                                                                                       |
| Stochastic  | 14, 3, 3 | %K from the close inside the high-low range, smoothed, then %D = SMA of %K. A zero range is 50.                                                   |
| ADX         | 14       | Wilder +DI / −DI / ADX. The seed is the sum of the first `period` DM and TR values; the first ADX is the average of the first `period` DX values. |
| CCI         | 20       | (source − SMA) / (0.015 × mean absolute deviation). A zero deviation is 0. Default source is typical price.                                       |
| OBV         | –        | Starts at 0. Adds volume when close rises, subtracts it when close falls.                                                                         |
| CMF         | 20       | Sum of money-flow volume / sum of volume. A flat bar contributes 0.                                                                               |
| Williams %R | 14       | Close location in the high-low range, from −100 to 0. A zero range is −50.                                                                        |
| Awesome     | 5 / 34   | SMA of median price, fast minus slow.                                                                                                             |
| Momentum    | 10       | Source minus the source `period` bars ago.                                                                                                        |
| ROC         | 10       | Percent change versus the source `period` bars ago. Blank when that older value is 0.                                                             |
| Aroon       | 25       | How recently the high and low occurred in the current bar plus `period` bars before it. 100 is now; 0 is `period` bars ago.                       |
| BOP         | 14       | SMA of (close − open) / (high − low). A flat bar is 0.                                                                                            |
| KDJ         | 9        | RSV is raw stochastic %K. K and D use 1/3 smoothing, seeded with the first RSV. J = 3K − 2D and is not clipped.                                   |
| Elder Ray   | 13       | Bull power = high − EMA; bear power = low − EMA.                                                                                                  |

## Honesty note

An indicator line changes as new bars are revealed, the same way it would in real time.
These are educational overlays, not trade recommendations.

Opening-range levels need a trading-day boundary (`day start` on the session, plus the UTC
offset). The built-in `SYNTH-` series is a short continuous sample and may not show a clean
session open. For a near-24h session-like practice file, import
[`PRACTICE-TECHIDX-24H`](https://github.com/Kinfxhk/candledrill-synth-samples)
(`SYNTH-TECHIDX-24H_1min.csv`) as described in the README. That file is synthetic
practice data only: not index-licensed, and not exchange, CME, or Nasdaq data.
It is not shipped in this repository.

## Out of scope

- Volume profile (a horizontal volume-by-price histogram). Lightweight Charts has no clean overlay for that; it is not faked as a time-series histogram.
- Heikin Ashi as a chart-type toggle. Practice fills, stops and drawings use real OHLC. Replacing those prices is not a trivial overlay.
- Order-flow, footprint
- Pine Script import
- Live or broker order routing
