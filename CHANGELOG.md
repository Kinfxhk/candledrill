# Changelog

All notable changes to CandleDrill are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.10] - 2026-10-24

### Added

- **Practice countdown.** The first time a new practice session opens, a center-screen 3→2→1 plays with a number animation, then Play starts on its own. Skip starts Play immediately. Opening that same session again does not show the countdown.

### Not in this version

- Fill model stays v4. `FORMING_PARTS` and forming candles are unchanged.

## [1.0.9] - 2026-10-24

Practice rules during a session are a thin strip above the chart, not a side card. The fill model is unchanged (v4). Forming candles and the 1D calendar are unchanged.

### Changed

- **Glance strip.** Under the toolbar and above the chart: daily loss, profit target, and trailing drawdown (with floor and buffer). Each limit has a hairline meter and turns red as it nears the cap. The bar-close note stays on the strip's tooltip.
- **Collapse and drag.** The strip folds to a chip. Drag the grip to float it inside the chart column; a drop on the OHLC legend or the order ticket (side ticket or the compact order row) does not stick. Release it at the top-left to dock again. Collapse and position are remembered on this device.
- **Side rail.** The practice-rules card and the rule-check card are no longer on the rail during a session. The rail keeps the order ticket, position, save points, and drawings. The full rule-profile check (pass / pending / fail) is the **Rule check** bottom tab. Profile create / edit / import stays on the Library card.

### Not in this version

- Fill model stays v4. `FORMING_PARTS`, forming paints, and the 1D demo calendar are unchanged.

## [1.0.8] - 2026-10-24

### Fixed

- **Language switch keeps one language.** Browser notice, rule-profile buttons and “No rule profile”, About and footer recommendations, the third-party heading, an open Settings dialog, empty save points, and the OHLC legend all follow the selected locale. The legend updates immediately; it no longer waits for the next crosshair move. Settings text updates while the dialog is open.
- **README live demo links.** The Traditional Chinese and English openings link to https://kinfxhk.github.io/candledrill/ with a visible URL, then the screenshot, then the risk notice.

## [1.0.7] - 2026-10-23

### Fixed

- **1D demos form in three steps.** Timeframe ÷ 3 still emits 8h bars for 1D (`FORMING_PARTS` stays 3). The 08:00–16:30 session held only one of those bars, so the daily candle closed on the first print. A 1D demo with no explicit calendar now uses a midnight-aligned full day (00:00–24:00): three 8h prints, then the daily close. 1m, 5m, 15m and 1h stay on the 8.5h session. Passing a calendar leaves that session unchanged. Fills still run on the practice-timeframe close (fill model v4).

## [1.0.6] - 2026-10-23

Forming candles use **timeframe ÷ 3** and paint across the whole play budget. The fill model is unchanged (v4): fills and rules still run on the practice-timeframe close.

### Changed

- **Source divisor is 3** (`FORMING_PARTS`). New demos: 1m←20s, 5m←100s, 15m←300s, 1h←20m, 1D←8h. A 5-minute file is three real bars of a 15m candle. CandleDrill does not invent prices inside a closed bar. Datasets from 1.0.4 (10s, 50s, 150s, 10m, 4h) still bind to the same practice close.
- **Slow play keeps building.** The gap between source paints is `budget / (paints − 1)` with the 140ms cap removed, so at 0.5×–2× the candle uses the play budget instead of finishing in a burst and sitting still. Play still waits until those paints finish before it fetches the next bar. One Next still shows the build (three or more source paints on a full practice bar).

### Not in this version

- Fill model stays v4. No intra-bar OHLC interpolation. The order ticket still opens on Market (1.0.5).

## [1.0.5] - 2026-10-23

The order ticket opens on Market. Forming candles stay timeframe ÷ 6. The fill model is unchanged (v4).

### Changed

- **Order ticket opens on Market.** A new practice session, the same ticket during a backtest, and the phone sheet start with Market selected (session status Active). Clicking the chart fills the price only and no longer switches that default to Limit. Limit and Stop stay on the ticket when you choose them. Semi-auto still sends a simulated market order.

## [1.0.4] - 2026-10-23

Forming candles for every practice timeframe use a source of **timeframe ÷ 6**.
The fill model is unchanged (v4): fills and rules still run on the practice-timeframe close.

### Added

- **5m ← 50s and 15m ← 150s** (1m ← 10s was already there). 1h ← 10m and 1D ← 4h use the same rule.
- **Demo practice timeframe.** Generate demo data follows the practice timeframe next to the button (default 1 minute). The chart menu does not gain a 10s/50s/150s option.
- A dataset that is already one practice bar (only 5m candles, for example) still fills on each close. CandleDrill does not invent prices inside that bar.

### Not in this version

- Fill model stays v4. Playback still counts practice bars, so one Next closes a practice bar and a market order can fill.

## [1.0.3] - 2026-10-23

Phone and tablet touch targets, spacing, and mis-tap guards. The fill model is unchanged (v4).

### Fixed

- **44px trade controls.** On viewports at or under 899px, and on short landscape, Buy, Sell, Flatten, speed, and the Play row are at least 44×44px, with a visible pressed state.
- **Flatten is harder to hit by accident.** The compact bar leaves a gap between Buy and Flatten. The first tap arms the button (Sure? / 確定？); a second tap within 3 seconds closes. A tap elsewhere cancels.
- **In-flight lock.** Generate demo, market Buy, market Sell, and Flatten ignore a second tap while the request is still running and show a short notice.
- **Larger hit areas.** The blind-practice checkbox row is at least 44px tall (the box itself is 22px). Bottom tabs on portrait phones and tablets are 44×44 and wrap so labels are not clipped. The drawer ✕ and the indicator-sheet ✕ are 44×44.
- **Closing a panel does not place an order.** The tap that dismisses a sheet is swallowed, including a tap that lands on Buy or Sell underneath.
- **Update notice.** On a narrow screen the banner uses less padding so it takes less of the first screen. Later and Don't show are unchanged.

### Not in this version

- No new swipe. The chart already pans when you drag it. Swiping between tabs would fight those clicks and the browser’s Back gesture.
- Fill model stays v4. Playback speed and the 1×/s default from 1.0.2 are unchanged.

## [1.0.2] - 2026-10-23

Phone and tablet practice can change playback speed. The fill model is unchanged (v4).

### Fixed

- **Playback speed on small screens.** Viewports at or under 899px (and short landscape) hid the toolbar speed control. The compact trade bar now shows the same dropdown on the Play row, so a phone can slow the tape without a keyboard.
- **Default speed is 1×/s.** A new browser profile starts at one bar per second. A later choice is remembered on this device. The desktop speed dropdown is unchanged.

## [1.0.1] - 2026-10-23

Phone usability fixes from real-device testing. The fill model is unchanged (v4).

### Fixed

- **Orders on phones.** "Next bar" now advances one practice bar (one 1m bar on 10s demo
  data, six source bars), so a market order fills on the first press instead of after
  several. +10, play and the keyboard step count practice bars too.
- **Play / pause.** The trade-bar play button shows pause while playing (and its label says
  so); a separate step glyph so play and step no longer look the same.
- **Blind practice.** Semi-auto is no longer offered while a blind session is hidden (button
  and tab are removed instead of leading to a warning). Generating demo data no longer shows
  a semi-auto warning.
- **Panels close sensibly.** One panel at a time: the drawer, the bottom panel, Indicators and
  the phone draw tools close on a tap outside, Escape, or opening another panel; the drawer
  has a ✕. The tap that closes a panel does nothing else (no stray drawing point or order).
- **No sideways swiping.** Toolbar and bottom tabs wrap instead of scrolling sideways, the page
  never scrolls horizontally, and the chart keeps its drags, so an edge swipe does not turn
  into the browser's Back gesture.
- **Fits the screen.** Practice fills the visible viewport; header controls stay on screen
  (language, Settings, About); touch inputs use 16px text so iOS does not zoom on focus; date
  and time fields are as wide as the other fields; saved sessions show as cards on phones and
  the table no longer grows under the new-session form on desktop.
- **Open bottom panel.** On phones the trade bar steps aside while a panel is open and the chart
  keeps at least 40% of the screen; folding the panel gives the chart its full height back.
- **Phone landscape.** Compact rows keep the chart at 150px or more.
- Light theme: muted text and accent meet 4.5:1 contrast; tab badges and the panel toggle are
  clearly visible.

### Included

- #27 (narrow-viewport layout): one-column forms, flexible chart row, indicator bottom sheet
  with 44px rows, no clipped price label over the candles, wrapped tab strip.

### Docs

- README: online version link at the top; all screenshots regenerated in the light theme.

## [1.0.0] - 2026-10-23

### Added

- **Browser version (GitHub Pages).** The engine runs in the page and stores data in
  IndexedDB, so phones and tablets can use CandleDrill from a URL with no install. Same
  routes and results as the local server (a parity test replays one session on both).
  Backup is one JSON file. Blind mode in the browser keeps practice honest but is not a
  lock against devtools (stated in the app).
- **Phone and tablet layouts.** Under 900px: chart first, rail as a drawer, sticky trade
  bar (back / play / next / +10, sell / qty / buy / close, 44px targets). Tablet landscape
  keeps the rail beside the chart.
- **Back (rewind) and save points.** Back restores the state before the last action; save
  points keep named moments per session. `PUT /api/sessions/:id/state` re-validates the
  state against the bars, so it cannot invent fills; off while a blind session is hidden.
- **Rule profiles.** User-defined (no firm presets): account size, profit target, daily
  loss, max loss with drawdown mode, consistency %, min/max trading days, profitable days,
  contract cap, flat-by time, no overnight, trades per day, losing streak. JSON
  import/export; a profile fills the session form; live rule check on the rail. Evaluation
  rules use revealed fills and trades only and never change fills; the Python oracle
  recomputes them.
- **Drawing tools.** Ray, vertical line, parallel channel, Fibonacci retracement, measure;
  magnet snap to OHLC; a Drawings card to show/hide, lock and delete.
- **Stop management.** Auto break-even and trailing stop move the stop-loss order after
  each bar close through the normal modify path (only ever tightens). Chart preview of the
  ticket's stop and target before ordering.
- **Settings.** Candle colours, grid, volume, quantity presets, default SL/TP, confirm
  before Flatten all, rebindable hotkeys; export/import.
- **Review tab.** Equity by closed trade, R distribution, Monte Carlo of the same trades
  reordered (seeded; drawdown percentiles and limit breach rate).
- **Chart.** OHLC legend, pinch / wheel zoom, touch pan, short fill markers.
- **Recommendations link** with affiliate and risk disclosure in About and the footer,
  folded by default and never next to order entry or rule alerts.

### Changed

- Practice screen: thin header, grouped replay controls, P&L chip, folding bottom panel with
  counts, ticket and position first on the rail, risk preview open by default.
- About and NOTICE: the "not affiliated" sentence now states no equity, agency, employment or
  official relationship and discloses affiliate links.
- Session-file import accepts text `fontSize` (the server already did).

## [0.5.0] - 2026-10-23

### Added

- **Forming 1m from finer source (dual-cursor, V0).** Synthetic (and CSV) can use a 10s
  source; the chart reveals those bars so a 1m pane updates as a real forming candle.
  Fills and practice rules still run only when the practice timeframe (default 1m) closes.
  No 10s chart option in the UI. Demo data generates 10s bars. Fill model version unchanged.

## [0.4.0] - 2026-10-15

### Added

- **Open-anchor separation (V1.0).** `SessionSettings.anchorMinutes` is the market-open clock for
  ORB / VWAP / `orb_break`. `dayStartMinutes` is only the daily-loss day boundary. New session
  form field; selecting a dataset prefills the anchor from the first bar’s exchange-local time.
- **Trailing drawdown modes (V1.1).** `trailingDrawdownMode`: `close` (legacy) | `eod` |
  `intraday` | `static`. Session state version 2 adds `eodPeak` / `intradayPeak`. Intraday
  breaches force-close at the adverse high/low (fill model **v4**).

### Changed

- `FILL_MODEL_VERSION` → `4`; exported `simulationPolicy.lossRuleBasis` records the mode
  (`closing-equity` | `end-of-day` | `intraday-high-low` | `static-floor`).
- Session export `formatVersion` → `2` (0.3.x readers reject; old files still import with
  defaults: `anchorMinutes = dayStartMinutes`, mode `close`).

## [0.3.3] - 2026-10-15

### Fixed

- **Version alignment.** Root and workspace `package.json` versions, the README status line,
  and `/api/health` `releaseVersion` now match the published GitHub releases (0.3.1 / 0.3.2
  were tagged while packages still said 0.3.0), so the in-app “new version” banner no longer
  falsely appears after those releases.

### Changed

- CI fails a tag push when the `v*` tag name (without the leading `v`) does not match the
  root `package.json` `version`, so release tags cannot drift from the declared version again.
- Vitest `testTimeout` and `hookTimeout` raised to 15s to cut intermittent timeouts on slower
  runners. Fill / trade model unchanged.

## [0.3.2] - 2026-10-14

### Changed

- **Semi-auto wizard UX rewrite (copy and layout only).** The bottom wizard is named
  半自動交易 (chart chip: 半自動 / Semi-auto). Step strip is 1 條件 → 2 進出場 → 3 跑一轉 →
  4 結果. Step 1 is indicator → reaction → Add, with ORB and SMA presets as small Quick
  apply chips. Step 3 shows a readiness line plus Backtest (From start / From here) and
  Follow while playing. Step 4 always shows a result card (never blank). Risk preview stays
  open when editing the ticket. Fill model unchanged; Follow runs on play / next bar in
  non-blind sessions only. Merged #19.

### Fixed

- **Risk preview.** Editing the ticket no longer collapses an expanded risk preview before
  its toggle event lands, so the cost breakdown stays available.

## [0.3.1] - 2026-10-14

### Changed

- **Practice rail cleanup and Macro as bottom-panel wizard.** Right column is practice
  rules → order ticket → position only. Bottom tabs are Working orders plus Macro as a
  four-step wizard. Run stays gated until name, qty, an enabled rule, and stop/target are
  valid, and lists what is missing. Blind sessions warn on the new-session form (and when
  demo data is generated with blind still on) and again when the session opens. The chart
  Macro button opens the bottom Macro tab. Fill model, macro DSL, and APIs unchanged.
  Merged #18.

## [0.3.0] - 2026-10-14

### Added

- **Indicator catalog v2.** The Indicators panel has typeahead search and category chips
  (Trend, Volatility, Momentum, Volume, Session). SMA and EMA are free-form instances, so a
  chart can show SMA(21) and SMA(200) together. Preferences move from the fixed-slot key
  `candledrill.indicators` to `candledrill.indicators.v2`; older lists are merged onto the
  previous defaults. At most 12 non-volume overlays are visible at once.
- **Opening range, Donchian, Stochastic and ADX.** ORB draws the session high/low (forming
  during the window, then frozen). Donchian is highest-high / lowest-low. Stochastic is
  smoothed %K and %D. ADX uses Wilder smoothing. Formulas are in `@candledrill/core` and
  only see bars already passed in.
- **Simulated macro.** A JSON condition list (price vs MA, ORB break, flat, time window,
  plus RSI / MACD / Bollinger / Donchian / Stochastic / ADX presets) can place a market
  order with a fixed stop and target (ticks, ATR multiple, percent, or R multiple). Rules
  are priority ordered. One position at a time is the default. **Run backtest** executes
  in the server via `POST /api/sessions/:id/macro-run` and reuses `computeStats`. It does
  not move the practice cursor and does not return trade timestamps. **Arm watch** follows
  the existing play loop, one bar at a time, through the same order API. The manual ticket
  stays on screen. Copy is Simulated / Educational. Set `localStorage`
  `candledrill.feature.macro` to `0` to hide the panel. Blind sessions stay blocked until
  reveal. See [docs/MACRO.md](docs/MACRO.md).

### Changed

- README status line now matches this release.

## [0.2.13] - 2026-10-13

### Fixed

- **Arrow tool:** thicker shaft, filled triangular head, and smaller endpoint handles so the
  arrow stays readable.
- **Indicators panel:** the Indicators button toggles the panel closed (same control /
  `aria-expanded`); click-outside still closes it.
- **SMA / EMA / VWAP (and other) colours:** colour changes apply immediately via series
  `applyOptions` without toggling the indicator off/on.
- **Volume:** shown as a toggleable row in the indicators panel (default on).
- **Risk preview:** wrapped in a collapsible section (collapsed by default, preference in
  `localStorage`) so it no longer blocks the ticket / position area.
- **Text tool:** after placing, select the label to edit colour and size (and Edit text);
  double-click also reopens the text prompt. Optional `fontSize` is persisted on drawings.
- **Long/short R tools:** the risk/reward body is draggable to reposition the whole tool
  (stop/target handles still adjust levels).
- **Check for updates:** failed GitHub lookups are only quiet-cached briefly; About →
  Check for updates sends `?refresh=1` so a newer release is detected when online (still
  no auto-download; respects the startup-check preference).

## [0.2.12] - 2026-10-11

### Changed

- **Drawing tools UX (Option A):** each chart pane has a single **collapsible floating
  palette** (Draw toggle). The duplicate top-toolbar drawing buttons are gone. Expanded
  strip keeps hline / trendline / rect / text / arrow / freehand / long / short; **Clear**
  is a labeled control with confirm (no bare × that looked like “close”). Esc cancels an
  active draw mode first, then collapses the palette. Expand preference is stored in
  `localStorage`.
- Language changes now refresh floating palette labels, Blind badge, Indicators panel, and
  drawing delete tooltips (create-time `t()` alone left them stuck in the old language).
- README **Synthetic data** points at the separate MIT samples repo
  [`Kinfxhk/candledrill-synth-samples`](https://github.com/Kinfxhk/candledrill-synth-samples)
  for a longer Globex-like practice CSV. Import with symbol `PRACTICE-NQ-GLOBEX` (not
  `SYNTH-`, which is reserved for the built-in generator), tick `0.25`, UTC offset `-300`.
  This app still ships **no market data**; sample CSVs stay out of this repo.

### Notes

- AGPL-3.0 for the app. Practice samples in `candledrill-synth-samples` are synthetic /
  MIT — not FirstRate or other vendor ticks.
- No immediate follow-up tag planned; treat this as the stable practice-UX cut after
  v0.2.9–v0.2.11 indicator / drawing / blind work.

## [0.2.11] - 2026-10-11

### Fixed

- SMA / EMA overlays support up to three periods at once (defaults 9 / 20 / 50 and 9 / 21 / 50).
- Text, arrow and freehand drawings actually save: the drawings API schema now accepts
  those kinds (they were only drawn in the UI), and freehand strokes call the save
  callback when the pointer is released.

## [0.2.10] - 2026-10-11

### Added

- `GET /api/health` reports `apiVersion` (the HTTP API schema version). The app version is
  `releaseVersion`.
- `GET /api/datasets` marks each dataset with `blindLocked` while an unrevealed blind
  session uses it.

### Changed

- While a blind session is hidden, the Export tab no longer offers **Session JSON** and
  explains why: the file must contain the real symbol and offsets so it can be imported
  again. Trades CSV and the HTML report stay available (they contain no disguise data).

### Removed

- `version` in `GET /api/health` (deprecated in the #13 follow-up). Use `apiVersion` for the
  HTTP schema and `releaseVersion` for the app version.

### Fixed

- README status line said v0.2.8 after the v0.2.9 release.
- Selecting a blind-locked dataset in the library no longer requests its preview, which
  logged a `423 Locked` error in the browser console.

## [0.2.9] - 2026-10-11

### Added

- **Technical indicators** on the practice chart: SMA, EMA, Bollinger Bands, session VWAP,
  RSI, MACD and ATR. Indicators are computed from revealed bars only (no look-ahead) and
  can be configured per chart pane from the new indicator panel.
- **Drawing tools**: text labels, arrows and freehand lines, plus a floating drawing palette
  on each chart. Trendlines now snap with a rubber-band second anchor while placing the
  second point.
- **Simplified Chinese, Japanese and Korean localisations** (`zh-Hans`, `ja`, `ko`), using
  the new language dropdown in the header.

### Changed

- **Blind practice is now on by default** and the preference is persisted. The blind checkbox
  is no longer auto-unchecked after creating a blind session, so users can start multiple
  blind sessions without re-enabling the option each time.
- Extend the v0.2.8 order-ticket risk preview for fresh entries from flat: cost-inclusive stop
  loss, percentage of current equity and net target reward:risk for each side.
  Expandable details separate price risk, commission and slippage. Assumptions
  and unsupported states are explicit; estimates do not guarantee fills or losses.

### Fixed

- Make the secret-scan script portable on Windows by replacing the bash wrapper with a
  cross-platform Node script.

Still planned:

- Per-session command queue, session revision and idempotent commands (no stale
  responses after quick session switches or retries)
- Toolbar reorganisation, resizable panels, simpler chart markers
- Correct handling of partial higher-timeframe buckets at the start of trimmed history
- CSV import: conflicting-duplicate detection, source line numbers, data-quality summary
- Intrabar (high/low-based) practice-rule checks; currently rules use bar closes
- Optional fixed-spread cost model (clearly labelled as an assumption, not historical
  spreads)
- Optional end-of-data settlement at the last close (`exitReason: end-of-data`)
- Optional "limit orders must trade through" fill mode
- Published npm package for `npx candledrill`; prebuilt container image

Postponed with reason: **daylight-saving-aware (IANA) session calendars**. Blind practice
depends on whole-week time shifts and the engine on fixed-offset trading days; changing
both safely is a design change larger than a minor release.

## [0.2.8] - 2026-10-11

### Added

- **Playback speed 0.5 bars/s** in the practice speed selector, keeping 1–120 bars/s.
  The carry math now works for fractional speeds. Keyboard shortcuts `[` / `]` and `-` / `=`
  change speed without touching the mouse.
- **Drawdown visibility panel**: when a trailing drawdown is set, the rules area shows the
  peak closing equity, the trailing floor, the current drawdown and the buffer to breach.
  A note documents that drawdown and practice rules use **closing equity**.
- **Numeric modify-order dialog** for working orders. Each working order has an edit button
  that opens a dialog for its price, stop-loss and take-profit (absolute prices). Illegal
  prices are rejected with the same clear engine message used by the API; the dialog stays
  open for correction.
- **Pre-trade risk preview** on the order ticket: money risk from quantity × stop distance
  (tick size × point value), or N/A when no stop is set.
- **Drag limit, stop and bracket SL/TP lines** vertically on the chart. Grab the small handle
  on the right-hand price scale, drag to a new price (snapped to tick), and release to commit
  via the existing `modifyOrder` API. An illegal price snaps the line back and shows the
  rejection message.

### Fixed

- **Oracle script encoding on Windows:** `tools/oracle/check.py` now opens its JSON input
  with an explicit UTF-8 encoding, so `npm run oracle` no longer fails with a `cp950`
  (or other locale) decode error on Windows.

## [0.2.7] - 2026-10-10

### Fixed

- **Unknown JSON fields are rejected with HTTP 400** instead of being silently
  stripped by Fastify’s default `removeAdditional: true`. A typo such as
  `stoploss` (instead of `stopLoss`) on place-order no longer places an order
  with no stop. Schemas that already set `additionalProperties: false` now
  honour that rejection.
- **Windows test runner:** skip Microsoft Store fake `python3` (exit 9009) when
  looking for a Python interpreter in the price-axis check; `npm run oracle`
  uses the same portable `scripts/run-python.mjs` helper.

## [0.2.6] - 2026-10-10

### Added

- **Optional “new version available” notice (no auto-download).** On startup the
  local server asks GitHub’s public Releases API (proxied at `GET /api/updates` so
  the browser stays on loopback under CSP). If a newer tag exists, a dismissible
  banner offers Later / Don’t show for this version and a link to the release page.
  About includes a startup-check toggle (default on) and a manual Check for updates.
  Offline or failed lookups stay silent. Never downloads or replaces binaries.

## [0.2.5] - 2026-10-10

### Fixed

- **A late journal response no longer replaces Statistics or a newer journal
  render.** Switching away from Journal (or refreshing Journal for another
  session) while a journal request was still in flight could overwrite the
  newer tab with stale journal HTML, because the bottom panel reused one DOM
  node and the error path did not check connectivity. Each refresh now mounts a
  fresh panel so pending responses keep a detached node; scroll position is
  restored after synchronous renders. Thanks to
  [@agent-rapi](https://github.com/agent-rapi) (#4).

## [0.2.4] - 2026-10-09

### Fixed

- **Import and restore no longer accept sessions whose profit contradicts fill
  accounting.** A session file with no fills but a huge `realizedPnl` was
  accepted (HTTP 201) and could pass a profit target on the next step. The
  shared session validator now replays fills through the engine and rejects
  forged or inconsistent financial totals with HTTP 400, without inserting the
  session. Thanks to [@agent-rapi](https://github.com/agent-rapi) (#3).

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

[Unreleased]: https://github.com/Kinfxhk/candledrill/compare/v0.3.3...HEAD
[0.4.0]: https://github.com/Kinfxhk/candledrill/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/Kinfxhk/candledrill/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Kinfxhk/candledrill/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Kinfxhk/candledrill/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Kinfxhk/candledrill/compare/v0.2.13...v0.3.0
[0.2.13]: https://github.com/Kinfxhk/candledrill/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/Kinfxhk/candledrill/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/Kinfxhk/candledrill/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/Kinfxhk/candledrill/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/Kinfxhk/candledrill/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/Kinfxhk/candledrill/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/Kinfxhk/candledrill/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/Kinfxhk/candledrill/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/Kinfxhk/candledrill/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/Kinfxhk/candledrill/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/Kinfxhk/candledrill/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/Kinfxhk/candledrill/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Kinfxhk/candledrill/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Kinfxhk/candledrill/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Kinfxhk/candledrill/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Kinfxhk/candledrill/releases/tag/v0.1.0
