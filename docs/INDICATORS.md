# CandleDrill built-in indicators

CandleDrill includes a small set of common technical indicators for visual reference
while practising. They are computed in the browser from the **revealed bars only** —
no future data is ever used. Indicators are optional, configurable and stored as a
local UI preference; they are not part of the session state.

## Available indicators

### Overlay indicators (on the price chart)

| Indicator       | Default | Formula                                                                                   |
| --------------- | ------- | ----------------------------------------------------------------------------------------- |
| SMA             | 20      | Simple moving average of the selected source                                              |
| EMA             | 21      | Exponential moving average, alpha = 2/(period+1)                                          |
| Bollinger Bands | 20, 2   | Middle = SMA(20); upper/lower = middle ± 2 × sample standard deviation                    |
| Session VWAP    | –       | Cumulative Σ(typical × volume) / cumulative Σ(volume), reset at each exchange trading day |

### Pane indicators (below the price chart)

| Indicator | Default | Formula                                                                      |
| --------- | ------- | ---------------------------------------------------------------------------- |
| RSI       | 14      | Wilder's RSI: smoothed average gain / average loss                           |
| MACD      | 12/26/9 | MACD = EMA(12) − EMA(26); signal = EMA(9) of MACD; histogram = MACD − signal |
| ATR       | 14      | Wilder's average true range                                                  |

## Customisation

Each chart pane has an **Indicators** button in its header. You can toggle visibility,
change the period, choose the source price (open/high/low/close/hlc3) and pick a colour.
Settings are saved to `localStorage` and apply to every chart pane.

## Honesty note

Indicators are calculated from already-revealed bars only. Because the app deliberately
hides future bars during practice, an indicator line will lag or change shape as new bars
appear, exactly as it would in real time. No indicator knows tomorrow's close. These are
educational overlays, not trade recommendations.

## Out of scope

The following are intentionally not included in this release:

- Supertrend
- Ichimoku
- Order-flow / volume-profile indicators
- Pine Script import
- Alerting or automated strategy execution
