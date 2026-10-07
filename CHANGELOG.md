# Changelog

All notable changes to CandleDrill are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Planned for v0.2:

- Crosshair and visible-range sync between the two charts
- Drag-to-modify orders and drawings on the chart
- Intrabar (high/low-based) practice-rule checks; currently rules use bar closes
- Daylight-saving-aware session calendars (currently a fixed UTC offset)
- Import a session from its exported JSON
- Optional "limit orders must trade through" fill mode
- Published npm package for `npx candledrill`
- Prebuilt container image

## [0.1.0] - 2026-10-08

First public release.

### Added

- CSV import with automatic delimiter, header, column and timestamp detection,
  a mapping dialog, strict bar validation and a row-level error report
  (up to 1,000,000 bars per dataset).
- Deterministic synthetic demo data (`SYNTH-` symbols); no real market data is bundled.
- Replay: next bar, ten bars, play at 1–120 bars/s, jump forward to a date.
  Server-side cursor; the browser only receives revealed bars (no look-ahead),
  covered by property-based tests.
- Timeframe aggregation (1m, 5m, 15m, 1h, daily) from revealed bars only, with a
  configurable UTC offset and trading-day start; two-chart split view.
- Simulated market, limit and stop orders; bracket orders with stop-loss and
  take-profit (OCO); modify, cancel, flatten. Commission and slippage.
  Conservative same-bar rule: stop-loss before take-profit.
- Position, P&L, equity, trade log, fills, chart markers and order lines.
- Statistics: win rate, expectancy, profit factor, R-multiples, max drawdown,
  streaks; exports to CSV (formula-injection safe), HTML report and session JSON.
- Practice rules: daily loss limit, trailing drawdown, profit target, with
  forced flatten and trading lock on breach or target.
- Horizontal and trend-line drawings saved per session.
- Sessions persisted in a local SQLite database (schema migrations).
- English and Traditional Chinese UI, dark and light themes, keyboard shortcuts.
- `npm start` one-command local run; Dockerfile and `compose.yaml` publishing on
  127.0.0.1 only.
- Security: loopback-only bind, Host-header check, strict CSP and security headers.
- Tooling: `npm run check` (lint, format, typecheck, tests, licence allowlist,
  no-market-data and attribution checks, gitleaks secret scan) and a Playwright
  headless smoke test, both in CI.

[Unreleased]: https://github.com/Kinfxhk/candledrill/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Kinfxhk/candledrill/releases/tag/v0.1.0
