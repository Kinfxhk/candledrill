# CandleDrill

**CandleDrill** (Chinese name: **K線操練場**) is a free, open-source, self-hosted
candlestick **replay practice tool**. You load price bars, step through them one
candle at a time without seeing the future, place simulated orders, and review
your results, all on your own computer, with no account, no subscription and no
telemetry.

> **Status: pre-alpha (milestone M0).** The engine foundation, synthetic data
> generator, local server and project tooling exist. There is no usable replay UI
> yet. See the [roadmap](#roadmap).

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
  any other address. Your data stays in a local SQLite file
  (default `~/.candledrill/candledrill.db`).
- **No telemetry.** No analytics, no tracking, no phoning home.
- **No bundled market data.** The demo uses a deterministic **synthetic** data
  generator (symbols always start with `SYNTH-`). You import data you are
  entitled to use (CSV import arrives in M1).
- **No broker connections, no real orders.** Practice only.
- **Clean-room.** Built from written feature descriptions only; no code, UI,
  icons or text copied from any commercial product. See
  [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start (developers)

Requirements: Node.js 22+, npm.

```bash
npm ci
npm run check          # lint, format, typecheck, tests, licence, data and secret checks
npm run dev:server     # http://127.0.0.1:4870/api/health
npm run dev:web        # http://127.0.0.1:4871 (placeholder page)
```

Create a synthetic demo dataset:

```bash
curl -s -X POST http://127.0.0.1:4870/api/datasets/synthetic \
  -H 'content-type: application/json' \
  -d '{"seed": 42, "startDate": "2026-10-05", "days": 5}'
```

Environment variables: `CANDLEDRILL_PORT` (default 4870),
`CANDLEDRILL_DATA_DIR`, `CANDLEDRILL_DB`. `CANDLEDRILL_HOST` may only be
`127.0.0.1`.

## Repository layout

```
packages/core     Pure TypeScript engine (no I/O): data model, seeded RNG,
                  session calendar, synthetic OHLCV generator, bar validation
packages/server   Fastify + SQLite local server (127.0.0.1 only)
packages/web      Browser UI (placeholder in M0)
scripts/          Licence allowlist check, secret scan, no-market-data check
docs/             Licensing record
```

## Synthetic data

`generateSyntheticBars({ seed, startDate, days, ... })` produces 1-minute OHLCV
bars that look like an intraday market (volatility clustering, busier open and
close, gaps between sessions, tick-rounded prices, optional missing minutes) but
are **entirely made up**. Same seed and options give byte-identical output; a
golden snapshot test guards this. Session calendars use a fixed UTC offset
(daylight-saving time is not modelled yet).

## Roadmap

| Milestone | Scope                                                                                       |
| --------- | ------------------------------------------------------------------------------------------- |
| M0        | Repo, licence, tooling, data model, synthetic generator (this release)                      |
| M1        | CSV import with column mapping and validation; static chart                                 |
| M2        | Replay clock (step, play, speed, jump to date) without future leakage; timeframe resampling |
| M3        | Simulated orders: market, limit, stop, OCO brackets, fees, slippage                         |
| M4        | Positions and P&L panel, trade log, save/resume sessions                                    |
| M5        | Statistics report, CSV/HTML export                                                          |
| M6        | User-defined practice rules (daily loss limit, trailing drawdown, target)                   |
| M7        | Multi-timeframe view, basic drawing tools, shortcuts, zh-Hant/en UI                         |
| M8        | Packaging (npx, Docker), docs, v0.1.0                                                       |

## 繁體中文簡介

**K線操練場（CandleDrill）** 是一個免費、開源、在自己電腦運行的K線回放練習工具：
匯入K線後逐根前進（看不到未來K線），進行模擬落單，再檢討成績。毋須帳戶、毋須訂閱、
不收集任何使用數據。

- **現階段**：M0（開發初期），已有核心引擎基礎、合成數據產生器、本機伺服器及開發工具；
  回放介面尚未完成。
- **只在本機運行**：伺服器只綁定 `127.0.0.1`，數據存於本機 SQLite 檔。
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
