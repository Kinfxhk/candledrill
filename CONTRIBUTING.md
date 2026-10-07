# Contributing to CandleDrill

Thank you for helping. CandleDrill exists to give everyone a free, local
alternative to subscription replay tools, so legal cleanliness matters as much
as code quality.

## Clean-room rule (mandatory)

1. **Do not copy proprietary code, UI, assets or text** from any commercial or
   closed-source product, including (but not limited to) FX Replay, Forex Tester,
   TradeZella, TradingView's commercial platform, NinjaTrader or any broker or prop
   firm software. This covers source code, decompiled code, screenshots used as
   design templates, layouts, colour schemes, icons, sounds, documentation text,
   help articles and marketing copy.
2. Work only from **written functional descriptions** (for example "a bracket
   order has a stop and a target; when one fills the other is cancelled"). If you
   have studied a competitor's internals or non-public material, do not contribute
   code for that feature.
3. **No real market data** in the repository: no CSV/Parquet/database dumps,
   no screenshots of real charts with data, no downloaders that scrape websites.
   Tests use the synthetic generator.
4. **No trademarks as branding.** Competitor names may appear only in plain
   factual comparisons with a trademark notice. Do not add exchange or prop-firm
   names as presets; users enter their own contract specifications.
5. **Third-party code** must be an npm dependency (or a clearly separated vendored
   file with its licence) under an AGPL-3.0-compatible licence. Do not paste
   snippets of unknown origin, including from Q&A sites or AI tools, unless you can
   identify their licence.

## Developer Certificate of Origin

All commits must be signed off (`git commit -s`), certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote
the change or otherwise have the right to submit it under AGPL-3.0-or-later.

## Development

```bash
npm ci
npm run check
```

- `packages/core` must stay **pure**: no I/O, no `Date.now()`, no `Math.random()`
  (ESLint enforces this). Use the seeded RNG.
- New behaviour needs tests. Prefer property tests (fast-check) for invariants such
  as "never leak future bars".
- If you change the synthetic generator's output, bump
  `SYNTHETIC_GENERATOR_VERSION` and update the golden snapshot deliberately.
- Never commit secrets. `npm run check:secrets` runs gitleaks when installed.

## Responsible features

We do not accept features that present the tool as a way to get rich, add
leaderboards or gamification that encourages over-trading, give signals or
"predictions", or connect to real brokerage accounts.

## Licence

By contributing you agree that your contribution is licensed under
AGPL-3.0-or-later.
