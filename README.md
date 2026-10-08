# CandleDrill

**CandleDrill** (Chinese name: **K線操練場**) is a free, open-source, self-hosted
candlestick **replay practice tool**. Load price bars, step through them one candle
at a time without seeing the future, place simulated orders, and review your
results. Everything runs on your own computer, with no account, no subscription and
no telemetry.

> **Status: v0.1.1.** Usable end to end. v0.1.1 fixes simulation and security issues
> found by an external review (see the [CHANGELOG](CHANGELOG.md)). Expect rough edges;
> please report bugs in the issue tracker.

![CandleDrill practice screen with synthetic demo data: two synchronised timeframes, an open bracket position, order ticket and trade log](docs/screenshot.png)

<sub>Screenshot uses generated `SYNTH-` demo data, not real market prices.</sub>

## Risk notice

CandleDrill is an **educational practice tool**. It is **not investment advice**,
it gives no trading signals, and **simulated or practice results do not predict
real trading results**. Trading futures, forex and other leveraged products can
lose more than your deposit. Bar-based simulation cannot know the true order of
prices inside a bar; CandleDrill will always state the assumptions it uses.

## Why

Bar-replay and manual backtesting are mostly sold as monthly subscriptions.
CandleDrill aims to provide the core practice workflow as free software that
anyone can install once and run locally forever.

CandleDrill is an independent project and is **not affiliated with, endorsed by,
or sponsored by FX Replay, Forex Tester, TradeZella or TradingView** (or any broker,
exchange, data vendor or prop firm). Those names are trademarks of their
respective owners and appear here only for plain factual comparison.

## Principles

- **Self-hosted, local-only.** The server binds to `127.0.0.1` only and refuses
  any other address. The one exception is the container image, which listens on
  `0.0.0.0` inside the container and must be published on the host's `127.0.0.1`
  (see Docker below). Your data stays in a local SQLite file
  (default `~/.candledrill/candledrill.db`).
- **No telemetry.** No analytics, no tracking, no phoning home.
- **No bundled market data.** The demo uses a deterministic **synthetic** data
  generator (symbols always start with `SYNTH-`). You import data you are
  entitled to use.
- **No broker connections, no real orders.** Practice only.
- **Clean-room.** Built from written feature descriptions only; no code, UI,
  icons or text copied from any commercial product. See
  [CONTRIBUTING.md](CONTRIBUTING.md).

## Features (v0.1)

- **Data library**: CSV import with a column-mapping dialog (delimiter, header,
  timestamp format and time zone detection, preview), strict validation (OHLC
  consistency, duplicates, ordering) with a row-level report. A deterministic
  synthetic generator makes demo data in one click.
- **Replay without look-ahead**: step one bar, ten bars, play at 1–120 bars/s,
  jump forward to a date. The server keeps the full series, and a practice session
  only ever receives bars up to the replay cursor. Note: the data library shows a
  preview of the dataset (its most recent bars) before you start, so this guards
  against accidental look-ahead during practice, not against reading your own data.
  See [What "no look-ahead" covers](docs/FILL-MODEL.md#what-no-look-ahead-covers).
- **Timeframes**: 1m, 5m, 15m, 1h and daily, aggregated from the revealed bars
  only (a forming higher-timeframe bar never shows the future). Two-chart split
  view for multi-timeframe practice.
- **Simulated orders**: market, limit, stop; bracket orders with stop-loss and
  take-profit (OCO); atomic modify (re-validated, logged) and cancel; flatten all. Commission per contract and
  slippage in ticks.
- **Positions and P&L**: average price, open and closed P&L, equity, trade log,
  fills, markers and order lines on the chart.
- **Statistics**: win rate, expectancy, profit factor, average R-multiple, max
  drawdown, streaks and more. Export trades to CSV, a self-contained HTML report,
  or session JSON.
- **Practice rules** (optional): daily loss limit, trailing drawdown, profit
  target. A breach or target hit closes positions and locks trading for that
  session, so you can rehearse a rule-based routine.
- **Drawings**: horizontal and trend lines, saved with the session.
- **Sessions** are saved automatically in a local SQLite file; resume any time.
- **UI**: English and 繁體中文, dark and light themes, keyboard shortcuts
  (Space play/pause, → next bar, Shift+→ ten bars, B buy, S sell, F flatten,
  Esc cancel drawing).

## How fills are simulated

Bar data cannot tell what happened inside a bar, so CandleDrill uses fixed,
conservative rules, shows them in the app, and records the engine and fill-model
version (currently **fill model v2**) in every report. Full details and limitations:
[docs/FILL-MODEL.md](docs/FILL-MODEL.md).

- Orders only fill on bars revealed **after** they were placed.
- Market orders fill at the next bar's open plus slippage.
- Limit orders fill at their price, or at the open if price gaps through it.
- Stop orders fill at their price, or at the open if gapped, plus slippage.
- Bracket stop-loss/take-profit orders follow the same rules from the moment the
  entry fills: if the open gaps through them, they fill at the open, never at a price
  outside the bar.
- If one bar touches both the stop-loss and the take-profit, the **stop-loss is
  assumed to fill first**.
- Drawdown and practice rules are evaluated on each bar's close. The profit target
  counts only **after estimated exit commission and slippage**.
- At the end of the data an open position **stays open**, valued at the last close.
  Working orders are cancelled and Flatten is disabled, because there is no later bar.
- R-multiples use the stop-loss risk of every entry; R is **N/A** if any entry had no
  stop-loss.

## Quick start

Requirements: [Node.js](https://nodejs.org/) 22 or newer and npm.

```bash
git clone https://github.com/Kinfxhk/candledrill.git
cd candledrill
npm ci
npm start            # builds the UI and serves it at http://127.0.0.1:4870/
```

Then open <http://127.0.0.1:4870/>, click **Generate demo data** (or **Import
CSV**), fill in the session form and press **Start practising**.

Your data is stored in `~/.candledrill/candledrill.db`. Settings via environment
variables: `CANDLEDRILL_PORT` (default 4870), `CANDLEDRILL_DATA_DIR`,
`CANDLEDRILL_DB`, `CANDLEDRILL_LOG_LEVEL` (default `warn`). `CANDLEDRILL_HOST` may
only be `127.0.0.1`. No C++ build tools are needed: the repository's `.npmrc` skips
install scripts and the SQLite driver ships prebuilt binaries.

### Docker

```bash
docker compose up --build    # http://127.0.0.1:4870/
```

`compose.yaml` publishes the port on the host's **127.0.0.1 only** and keeps data
in the `candledrill-data` volume. Inside the container the server listens on
`0.0.0.0` (allowed only when `CANDLEDRILL_CONTAINER=1`, which the image sets) so
Docker can forward the port. With plain Docker, always bind to loopback:
`docker run -p 127.0.0.1:4870:4870 -v candledrill:/data candledrill`. CandleDrill
has no login, so never expose it to a network.

### CSV format

One row per bar with a timestamp, open, high, low, close and (optional) volume.
Column names, order and delimiter are flexible: the import dialog guesses the
mapping and lets you correct it. Timestamps may be ISO 8601 (with or without a
zone), `YYYYMMDD HHMMSS`, day- or month-first dates, or Unix seconds/milliseconds.
Times without a zone are interpreted with the UTC offset you choose. Only import
data you are entitled to use; CandleDrill ships no market data.

## Development

```bash
npm run check          # lint, format, typecheck, unit/property/golden tests,
                       # licence allowlist, no-market-data + attribution, secret scan
npm run dev:server     # API on http://127.0.0.1:4870
npm run dev:web        # Vite dev server on http://127.0.0.1:4871 (proxies /api to 4870)
npm run test:e2e       # headless browser smoke test (Playwright)
```

`npm run test:e2e` needs a Chromium: run `npx playwright install chromium` once,
or point to an installed browser with `PW_CHROMIUM_PATH=/usr/bin/google-chrome`.
`npm run screenshot` regenerates `docs/screenshot.png` against a running server.

## Repository layout

```
packages/core     Pure TypeScript engine (no I/O, no clock): data model, CSV import,
                  aggregation, replay, order matching, accounting, stats, rules, export
packages/server   Fastify + SQLite local server (127.0.0.1 only)
packages/web      Browser UI (vanilla TypeScript + Lightweight Charts™)
e2e/              Playwright smoke test
scripts/          Licence allowlist, secret scan, no-market-data/attribution checks
docs/             Licensing record, screenshot
```

## Synthetic data

The demo generator produces 1-minute bars that look like an intraday market
(volatility clustering, busier open and close, session gaps, tick-rounded prices)
but are **entirely made up**; symbols always start with `SYNTH-`. Same seed gives
byte-identical output, guarded by a golden snapshot test.

## Roadmap

v0.1 covers the core practice loop. Planned for v0.2 (see [CHANGELOG](CHANGELOG.md)):
a command queue with stale-response protection, numeric order modification with a
risk preview, a blind-practice entry (no preview, random start), toolbar and panel
improvements, crosshair and time-scale sync between charts, better CSV data-quality
reporting, session JSON import with backup/restore, intrabar rule checks,
daylight-saving-aware calendars, and an `npx` package.

## Privacy and security

- The server binds to `127.0.0.1` only and refuses other addresses (container
  exception above); it also rejects requests whose `Host` header is not loopback
  (DNS-rebinding defence).
- **Cross-origin protection:** every state-changing request must carry a random
  token generated at each launch (`X-CandleDrill-Token`), which only pages served by
  CandleDrill itself can read. Requests whose `Origin` is not exactly CandleDrill's own
  origin (including other localhost ports and `null`) are refused. No CORS headers
  are ever sent. Scripts on your own machine can fetch the token from
  `GET /api/token` and send it with writes.
- Strict Content-Security-Policy, no third-party requests, no analytics.
- CSV exports are protected against spreadsheet formula injection.
- **Sharing reports:** exports contain no price bars, but they do contain entry and
  exit prices, times and drawings derived from your data. Check your data provider's
  licence before publishing a report built on real market data.
- Loopback is not a sandbox: other software running on your computer can reach
  `127.0.0.1`. Do not expose CandleDrill to a network; it has no login.
- See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Third-party attribution

Charts are rendered with [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/)
(Apache-2.0), Copyright (с) 2025 TradingView, Inc. The required NOTICE and a link to
<https://www.tradingview.com/> are shown in the app footer and About dialog (and
the library's logo link is kept). Full list: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## 繁體中文簡介

**K線操練場（CandleDrill）** 是一個免費、開源、在自己電腦運行的K線回放練習工具：
匯入K線後逐根前進（看不到未來K線），進行模擬落單，再檢討成績。毋須帳戶、毋須訂閱、
不收集任何使用數據。

- **現階段**：v0.1.1。修正外部檢討指出的成交及安全問題（跳空時括號單只會以開市價成交、
  改單會重新驗證、數據尾端政策、盈利目標扣除平倉成本、R 值風險覆蓋、本機 API 跨來源防護、
  嚴格時間格式），並加入 Windows 自動測試。功能包括：CSV 匯入、練習期間不傳送未來K線的
  回放、多時間框架、市價／限價／止蝕單及括號單（止蝕＋止賺）、持倉與盈虧、統計報告及匯出、
  自訂練習規則（每日虧損、移動回撤、盈利目標）、畫線、中英介面及深淺色主題。
- **成交規則**：詳見 [docs/FILL-MODEL.md](docs/FILL-MODEL.md)（英文）。報告會列明引擎及成交
  模型版本。
- **「無未來數據」的範圍**：練習進行中只會收到游標以前的K線；但資料庫頁面在開始前會預覽數據，
  而數據本身存於本機，所以只能避免意外先見，並非防作弊。
- **分享報告**：匯出檔不含K線，但含有由數據衍生的成交價及時間；以真實行情練習時，公開前請
  先確認數據授權。
- **快速開始**：安裝 Node.js 22 後執行 `npm ci && npm start`，打開 http://127.0.0.1:4870/ 。
- **只在本機運行**：伺服器只綁定 `127.0.0.1`（Docker 容器內部例外地監聽 `0.0.0.0`，但只可
  發佈到本機 `127.0.0.1`），數據存於本機 SQLite 檔。所有改動數據的請求都須附上每次啟動
  隨機產生的權杖，其他網站發出的請求會被拒絕。
- **不附帶真實行情**：示範數據全部由程式合成（代號以 `SYNTH-` 開頭）；用戶須自行匯入
  有權使用之數據。
- **不連接任何經紀或平台，不會真實落單。**
- **與 FX Replay、Forex Tester、TradeZella 或 TradingView 並無任何關係**，亦未獲其認可或
  贊助；上述名稱屬其持有人之商標，此處只作事實性比較。

**風險聲明**：本工具只作教育及練習用途，**並不構成任何投資建議**，亦不提供交易訊號；
**模擬或練習成績不能預示真實交易結果**。槓桿產品之虧損可能超過本金。

## Licence

[GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later).
If you modify CandleDrill and let others use it over a network, you must offer them
your source code under the same licence. Third-party notices:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Licensing record:
[docs/LICENSING.md](docs/LICENSING.md).

## Support

CandleDrill is free and will stay free. If it helps you, you can support
development here: https://buymeacoffee.com/kinfxhk

如果這個工具對你有幫助，歡迎支持開發：https://buymeacoffee.com/kinfxhk
