# Changelog

All notable changes to CandleDrill are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Planned for v0.2:

- Per-session command queue, session revision and idempotent commands (no stale
  responses after quick session switches or retries)
- Numeric order-modify dialog (stop-loss/take-profit/price) and a pre-trade risk preview
- Blind-practice entry: no dataset preview, random start, review marking
- Toolbar reorganisation, resizable panels, simpler chart markers
- Crosshair and visible-range sync between the two charts
- Correct handling of partial higher-timeframe buckets at the start of trimmed history
- CSV import: conflicting-duplicate detection, source line numbers, data-quality summary
- Import a session from its exported JSON (with dataset fingerprint), backup/restore
- Drag-to-modify orders and drawings on the chart
- Intrabar (high/low-based) practice-rule checks; currently rules use bar closes
- Daylight-saving-aware session calendars (currently a fixed UTC offset)
- Optional end-of-data settlement at the last close (`exitReason: end-of-data`)
- Optional "limit orders must trade through" fill mode
- Published npm package for `npx candledrill`; prebuilt container image

## [0.1.1] - 2026-10-08

Correctness and security release based on an external code review. **Fill model v2:**
some fills, rule outcomes and R values differ from 0.1.0 (details below and in
[docs/FILL-MODEL.md](docs/FILL-MODEL.md)). Sessions created with 0.1.0 still open and
continue under the new rules.

### Fixed

- **Bracket orders on a gap (P0).** Stop-loss/take-profit children created on their
  entry bar used a separate touch check and filled at their own price, even when the
  bar had gapped through it, so they could fill outside the bar (e.g. bought 95,
  "stopped" at 98 when the bar high was 96). They now use the same trigger rules as
  every other order: a child already crossed when it becomes active fills at the bar
  open (or at the entry price after an intrabar entry). After an intrabar entry the
  take-profit no longer fills on the entry bar.
- **Modifying an entry did not re-validate its bracket (P0).** Moving a buy limit from
  99 to 90 kept a stop-loss of 95 above the entry. Modifications are now atomic:
  price, stop-loss and take-profit are validated together and applied in full or
  rejected. Protective orders cannot be moved to an already marketable price. Every
  accepted change is logged with before/after prices (`state.trading.modifications`).
  The API accepts `price`, `stopLoss`, `takeProfit` and `shiftBracket`.
- **Position open at the end of the data (P1).** Flatten queued an order for a next bar
  that never comes, so it stayed working forever. New end-of-data policy `keep-open`:
  working orders are cancelled, the position stays open at the last close, Flatten and
  new orders are refused (the UI disables Flatten), and reports show the open position
  separately.
- **Profit target passed before exit costs (P1).** The target now counts net of
  estimated exit commission and slippage, so a passed session never realizes less
  than the target (previously net 9 could pass a target of 10).
- **R-multiple after a scale-in (P1).** R used only the first entry's risk. It now uses
  the stop-loss risk of every entry fill and is N/A when any entry had no stop-loss.
  New trade fields: `riskComplete`, `firstEntryRisk`, `firstEntryR`, `plannedRisk`,
  `unprotectedQty` (also added as trailing columns to the trades CSV). Risk is
  directional: an entry filled beyond its own stop-loss has zero risk and R is N/A.
- **Cross-origin writes (P1).** Loopback binding and the Host check did not stop a page
  on another origin from sending simple requests (a cross-origin `text/plain` POST to
  flatten and a DELETE were accepted). State-changing requests now need a per-launch
  random token (`X-CandleDrill-Token`, served by `GET /api/token` to the app's own
  origin only), and a browser-supplied `Origin` must be exactly the app's own origin
  (`null`, foreign and other-port origins are refused).
- **Timestamp parsing (P1).** `24:30` rolled over to the next day and offsets such as
  `+99:99` were accepted. Hours must be 0–23, minutes/seconds 0–59, and offsets within
  ±14:00 with valid minutes.
- **Licence gate (SPDX).** The split-based evaluator ignored parentheses and precedence
  and accepted `(MIT OR GPL-2.0-only) AND GPL-2.0-only` for an MIT-only allowlist. It is
  now a strict SPDX expression parser (`WITH` > `AND` > `OR`) that fails closed.
- **Windows.** The config test hard-coded a POSIX path; the licence gate called
  `execFileSync('npm')` (ENOENT on Windows); the Playwright web server used a Unix
  `.bin` path; CRLF checkouts broke the format check. Fixed with `node:path`, a Node
  entry point for npm, `node --import tsx`, and `.gitattributes` (LF).

### Added

- `SIMULATION_POLICY`, `ENGINE_VERSION` and `FILL_MODEL_VERSION` in reports, session
  JSON exports and `/api/health`.
- `docs/FILL-MODEL.md`: fill rules, policies and model limitations.
- Regression tests for every item above (symmetric long/short, stop-loss/take-profit,
  gap/no-gap, with and without costs), property tests (no fill outside the bar; a
  passed target never ends below it) and browser-level cross-origin tests.
- CI: a `windows-latest` job (lint, format, typecheck, tests, licence and data checks,
  browser tests).

### Changed

- Documentation now limits the "no look-ahead" promise to the practice-session data
  path (the library preview shows dataset bars before a session starts), documents the
  container `0.0.0.0` exception, and notes that exported reports contain prices and
  times derived from your data, so check your data licence before sharing them.

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

[Unreleased]: https://github.com/Kinfxhk/candledrill/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Kinfxhk/candledrill/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Kinfxhk/candledrill/releases/tag/v0.1.0
