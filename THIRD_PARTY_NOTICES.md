# Third-party notices

CandleDrill is licensed under AGPL-3.0-or-later. It uses third-party open-source
components under their own licences. The full dependency list (with licences) is
produced by `npm run check:licenses`, which also enforces an AGPL-3.0-compatible
allowlist in CI.

## Runtime dependencies

| Package            | Licence    | Notes                                                |
| ------------------ | ---------- | ---------------------------------------------------- |
| fastify            | MIT        | Local HTTP server                                    |
| @fastify/static    | MIT        | Serves the built web UI from the local server        |
| better-sqlite3     | MIT        | Local SQLite storage (bundles SQLite, public domain) |
| lightweight-charts | Apache-2.0 | Chart rendering in the browser UI (see below)        |

Transitive runtime dependencies are MIT, ISC, BSD or Apache-2.0 (see the licence
check output).

## TradingView Lightweight Charts™

The chart UI uses
[lightweight-charts](https://github.com/tradingview/lightweight-charts)
(Apache-2.0). Its README states:

> This license requires specifying TradingView as the product creator.
> You shall add the "attribution notice" from the NOTICE file and a link to
> <https://www.tradingview.com/> to the page of your website or mobile application
> that is available to your users.

The upstream NOTICE file reads:

```
TradingView Lightweight Charts™
Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/
```

**How CandleDrill complies:**

1. The attribution notice and a link to https://www.tradingview.com/ are shown in
   the page footer and in the About dialog, and the chart's `attributionLogo` option
   stays enabled.
2. The Apache-2.0 licence text and the upstream NOTICE are shipped with the UI in
   `packages/web/public/licenses/` (served at `/licenses/`).
3. The TradingView name and logo are not used as CandleDrill branding; the
   attribution is credit, not endorsement.
4. `packages/web/test/attribution.test.ts` and `scripts/check-no-market-data.mjs`
   fail CI if the attribution, link or logo option is removed.

Apache-2.0 is compatible with GPLv3/AGPLv3 (one-way: Apache-2.0 code may be
included in an (A)GPLv3 work). See `docs/LICENSING.md` for sources.
