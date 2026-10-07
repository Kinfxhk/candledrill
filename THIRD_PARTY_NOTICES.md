# Third-party notices

CandleDrill is licensed under AGPL-3.0-or-later. It uses third-party open-source
components under their own licences. The full dependency list (with licences) is
produced by `npm run check:licenses`, which also enforces an AGPL-3.0-compatible
allowlist in CI.

## Runtime dependencies (M0)

| Package        | Licence | Notes                                                |
| -------------- | ------- | ---------------------------------------------------- |
| fastify        | MIT     | Local HTTP server                                    |
| better-sqlite3 | MIT     | Local SQLite storage (bundles SQLite, public domain) |

Transitive runtime dependencies are MIT, ISC or BSD-3-Clause at the time of M0
(see the licence check output).

## Planned: TradingView Lightweight Charts™ (not yet included)

The chart UI planned for M1+ will use
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

**Obligations when the library is added (tracked for M1):**

1. Show the attribution notice above and a link to https://www.tradingview.com/ on
   the user-visible page (the `attributionLogo` chart option satisfies the link
   requirement; keep the text notice in the About/footer as well).
2. Ship the Apache-2.0 licence text and upstream NOTICE with any distribution.
3. Do not use the TradingView name or logo as CandleDrill branding; the attribution
   is credit, not endorsement.
4. Update the CI hygiene check to verify the attribution is present in the UI.

Apache-2.0 is compatible with GPLv3/AGPLv3 (one-way: Apache-2.0 code may be
included in an (A)GPLv3 work). See `docs/LICENSING.md` for sources.
