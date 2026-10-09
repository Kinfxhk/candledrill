# Changelog

All notable changes to CandleDrill are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Still planned:

- Per-session command queue, session revision and idempotent commands (no stale
  responses after quick session switches or retries)
- Numeric order-modify dialog (stop-loss/take-profit/price) and a pre-trade risk preview
- Toolbar reorganisation, resizable panels, simpler chart markers
- Correct handling of partial higher-timeframe buckets at the start of trimmed history
- CSV import: conflicting-duplicate detection, source line numbers, data-quality summary
- Drag-to-modify working orders on the chart
- Intrabar (high/low-based) practice-rule checks; currently rules use bar closes
- Optional fixed-spread cost model (clearly labelled as an assumption, not historical
  spreads)
- Optional end-of-data settlement at the last close (`exitReason: end-of-data`)
- Optional "limit orders must trade through" fill mode
- Published npm package for `npx candledrill`; prebuilt container image

Postponed with reason: **daylight-saving-aware (IANA) session calendars**. Blind practice
depends on whole-week time shifts and the engine on fixed-offset trading days; changing
both safely is a design change larger than a minor release.

## [0.2.3] - 2026-10-09

### Fixed

- **Switching practice sessions no longer lets a late response overwrite the new
  session.** A slow `step` / `place` / load from the previous session could still
  land after you had already opened another one, and the UI would show the old
  bars, position and working orders. The practice client now tags each request with
  a generation and ignores responses from an older generation. Thanks to
  [@agent-rapi](https://github.com/agent-rapi) (#1).
- **Restore no longer replaces the library with empty or invalid backup data.**
  A corrupt or incomplete backup JSON could wipe datasets and sessions. The
  server now validates the runtime payload before swapping the database file, and
  keeps the current library if validation fails. Thanks to
  [@agent-rapi](https://github.com/agent-rapi) (#2).

## [0.2.2] - 2026-10-08

### Fixed

- **A limit already at or through the last price no longer fills at the next open.**
  After a short, a buy limit placed above the last price was filled on the next bar's
  open and covered the short, even when that bar never traded the limit. The mirror
  did the same to a long: a sell limit below the last price flattened it at the next
  open. `placeOrder` (and modifying an entry limit) now rejects that order. The message
  says the limit is already at or through the market and would fill at the next open;
  use a market order to trade now, or rest the limit on the other side (buy below the
  last price, sell above it). A buy stop is still how to cover a short above the market.
  A limit that was valid when placed is unchanged: a later bar may still fill it at the
  open if that bar gaps through the price.

### Changed

- Fill model **v3** (`FILL_MODEL_VERSION`). Engine version stays 0.2.0, the same split
  0.2.1 used. Reports, session JSON and `GET /api/health` record v3.

## [0.2.1] - 2026-10-08

Patch from a hands-on review of 0.1.1. Fill model unchanged (**v2**).

### Fixed

- **Price-axis decimals.** The chart, last-price tag and stop-loss / take-profit
  tags use the tick's own decimal count (`0.25` → 2, `0.025` and `0.125` → 3).
  Version 0.1.1 used `ceil(-log10(tick))`, which is 1 for a 0.25 tick, so
  lightweight-charts showed 4145.75 as 4145.5 while the position panel showed
  4145.75. That formula was already replaced in 0.2.0; 0.2.1 locks it with unit
  tests and an independent Python check (`tools/oracle/price_axis.py`) that the
  displayed price string parses back to the price. `0.1`, `0.01` and `0.005`
  stay as they were.
- **Traditional Chinese no longer prints raw engine English** for the practice-rule
  banner (`daily loss limit 300` and the other rule reasons), exit reasons
  (stop-loss, take-profit, flatten, rule, manual), working-order types (market,
  limit, stop) and session status (active, breached, passed, finished). English
  uses the same table. Stored session files keep the English tokens.
- R-multiple hint and the dataset preview hint. The old R hint could be read as
  if the trade had a stop; it now says the trade has an entry with no stop-loss.
  The preview hint uses 選擇, not 揀.

### Changed

- The new-session form and the practice-rules card say rules are checked at each
  bar close, not while the bar is forming.
- Stop-loss and take-profit fields say a market order counts ticks from the last
  close, not from the fill.
- The closed-result label is “Realized P&L (incl. fees)” / 「已實現盈虧（含手續費）」,
  with a note that entry commission is included before any trade is closed.
- CSV import warns that the tick defaults to 0.01, and the dataset list shows the
  tick after import.
- The header wraps, so the About button no longer sticks out of a narrow window.
  The app is for a desktop browser (stated in the README).

- After a blind reveal, the clock shows the real exchange time (the disguised
  cursor minus the time shift), the same instant as the reveal banner. Before
  reveal it still shows day number, weekday and clock, with no calendar date.
  Chart prices stay disguised.
- Weekday names follow the UI language (English Mon–Sun, Traditional Chinese
  週一–週日) on the blind clock, the chart axis and the journal weekday table.
- Traditional Chinese drawing buttons say 好倉 R / 淡倉 R, matching the position
  panel. User-facing Chinese uses 入場/出場, 跳 and K線 (no space). English
  wording is unchanged.

## [0.2.0] - 2026-10-08

Feature release based on user-feedback research. Fill model unchanged (**v2**); results
of existing sessions do not change. Database schema 4 (adds the journal column; older
databases and backups are upgraded automatically).

### Added

- **Blind practice.** Random start (20–80% into the data); symbol shown as `BLIND`;
  times moved by a random whole number of weeks (260–1560) and prices by a random whole
  number of ticks, so weekday, time of day, P&L and R are unchanged. The server never
  sends real times, prices or the symbol while the session is hidden (checked by tests
  and by the independent oracle), the dataset preview answers `423 blind-lock`, and
  **Reveal** or finishing the data shows the real values. Disguise parameters use the
  operating system's cryptographic random source.
- **Session file import** (`Import session file`). Exported session JSON now carries a
  SHA-256 fingerprint of the dataset's bars; import refuses other data, re-checks every
  fill against its bar, the commission total and the position, and validates drawings
  and journal entries. Files from 0.1.x (no fingerprint) ask you to choose the dataset.
- **Full backup and restore** (`Back up everything` / `Restore from backup`): one SQLite
  file with all datasets, bars, sessions, drawings and journal entries. Restore checks the
  file read-only first (integrity check, allow-listed tables and indexes only, no
  triggers or views, known schema version, foreign keys, valid JSON), upgrades older
  backups on a copy, swaps in one transaction and keeps the previous database as
  `candledrill.db.before-restore-<timestamp>`.
- **Backup reminder** card after a few changes without a backup in 14 days; dismissable,
  stored only in the browser.
- **Drawing tools:** rectangle and long/short **R tool** (entry, stop, target, live
  risk:reward). Select to drag a drawing or its handles; Delete/Backspace or × removes it.
  Shapes are clipped to the plot area.
- **Linked charts** in split view: mirrored crosshair and right-edge time alignment
  (`Link charts` toggle, remembered).
- **Trade journal** tab: tags and a note per trade; bar-based MAE/MFE in ticks and R;
  results by exchange-local hour and weekday. Tags and notes are added to the trades CSV
  (`tags`, `note` columns, formula-injection safe) and the session JSON.
- **Independent Python oracle** (`tools/oracle/`, standard library only, `npm run
oracle`, runs in CI): re-derives fills, positions, P&L, commission, R and MAE/MFE for
  1000 random sessions, checks blind disguise exactness and leakage in real server
  responses, and the backup/restore round trip with SQLite's own integrity check.
- **Long-data benchmark** (`npm run bench`, 500,000 one-minute bars) with results in
  [docs/PERFORMANCE.md](docs/PERFORMANCE.md) and limits in the README.
- README: **Commitments** and **Your data** sections (EN and 繁體中文).

### Changed

- `tradesToCsv` gains `tags` and `note` columns (appended at the end).
- Price axis, drawing prices and fill markers use the dataset's tick precision (a 0.25 tick no longer
  shows one decimal).
- Blind sessions are named "Blind <date>" by default so the symbol does not leak into
  the session list.

### Fixed

- Clicks on the chart right after a drag were sometimes lost (now handled with native
  pointer events).

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

[Unreleased]: https://github.com/Kinfxhk/candledrill/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/Kinfxhk/candledrill/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Kinfxhk/candledrill/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Kinfxhk/candledrill/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Kinfxhk/candledrill/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Kinfxhk/candledrill/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Kinfxhk/candledrill/releases/tag/v0.1.0
