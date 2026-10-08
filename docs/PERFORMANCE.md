# Performance and limits

Measured on 2026-10-08 (台北時間 / UTC+8) for CandleDrill 0.2.0 on a Linux cloud VM:
8 vCPU Intel Xeon, 16 GiB RAM, Node.js 22.23, headless Google Chrome. Your numbers will
differ; rerun the scripts below on your own machine.

## Server and engine (`npm run bench`)

500,000 synthetic 1-minute bars (about four years of 08:00–16:30 weekday sessions),
imported through the real HTTP API as a 20.5 MiB CSV into a temporary database:

| operation                                                               | result   |
| ----------------------------------------------------------------------- | -------- |
| generate bars (core)                                                    | 1195 ms  |
| build CSV text                                                          | 334 ms   |
| import 500,000 bars (HTTP, CSV, validation + SQLite insert)             | 2473 ms  |
| database size after import                                              | 23.4 MiB |
| create session at 80% (first load of the bars into memory)              | 369 ms   |
| open session (sends the last 50,000 bars, 4.2 MiB JSON)                 | 54 ms    |
| step 1 bar (mean of 200, with orders being placed and closed)           | 0.9 ms   |
| step 5,000 bars in one action (API maximum per request)                 | 15 ms    |
| journal (MAE/MFE + hour/weekday stats)                                  | 2 ms     |
| full backup download (23.4 MiB)                                         | 263 ms   |
| restore that backup                                                     | 876 ms   |
| peak RSS of the benchmark process (includes the generator and CSV text) | 1012 MiB |

## Browser (`scripts/bench-browser.ts`)

Same 500,000-bar dataset in a running server, session opened at bar 400,000:

| operation                                                  | result                  |
| ---------------------------------------------------------- | ----------------------- |
| first render (page load, session fetch, chart drawn)       | 1841 ms                 |
| step 1 bar, one chart (click → server → redraw; 60 clicks) | median 67 ms, p95 91 ms |
| step 1 bar, split view (60 clicks)                         | median 62 ms, p95 86 ms |
| page JS heap after the run                                 | 174 MiB                 |

## Limits (enforced)

| limit                                | value                                 | where                       |
| ------------------------------------ | ------------------------------------- | --------------------------- |
| bars per CSV import                  | 1,000,000                             | `MAX_IMPORT_BARS` (core)    |
| CSV request size                     | 96 MiB                                | `MAX_IMPORT_BYTES` (server) |
| bars sent to the browser per session | last 50,000 revealed bars             | `MAX_HISTORY_BARS`          |
| bars per step request                | 5,000                                 | step API schema             |
| synthetic generator                  | 2,000,000 bars (366 days from the UI) | core / server               |
| backup file accepted by restore      | 1 GiB                                 | `MAX_RESTORE_BYTES`         |
| session file import                  | 20 MiB                                | `MAX_SESSION_FILE_BYTES`    |
| drawings per session                 | 200                                   | `MAX_DRAWINGS`              |

The full series stays in the server; the browser only ever holds the most recent 50,000
revealed bars (about 100 trading days of 1-minute data, more for higher timeframes), so
chart speed does not degrade as the dataset grows. Scrolling back further than that
within a session is not possible in 0.2.0.

## How to reproduce

```bash
npm ci
npm run bench                       # server/engine numbers, temporary database
# browser numbers: start an empty instance, then run the script against it
CANDLEDRILL_DATA_DIR=$(mktemp -d) CANDLEDRILL_PORT=4915 npm start
PW_CHROMIUM_PATH=/usr/bin/google-chrome node --import tsx scripts/bench-browser.ts http://127.0.0.1:4915 500000
```
