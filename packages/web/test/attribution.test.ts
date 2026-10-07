// SPDX-License-Identifier: AGPL-3.0-or-later
// Licence compliance: lightweight-charts (Apache-2.0) requires its NOTICE attribution and a
// link to https://www.tradingview.com/ on the user-visible page. This test fails if either
// disappears from the UI or if the chart's attribution logo is switched off.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(`${root}/index.html`, 'utf8');
const chartSrc = readFileSync(`${root}/src/chart.ts`, 'utf8');
const notice = readFileSync(`${root}/public/licenses/lightweight-charts-NOTICE.txt`, 'utf8');

describe('lightweight-charts attribution', () => {
  it('shows the NOTICE text in the footer and About dialog', () => {
    expect(notice).toContain('TradingView Lightweight Charts™');
    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
    expect(footer).toContain('TradingView Lightweight Charts™');
    expect(footer).toContain('Copyright (с) 2025 TradingView, Inc.');
    expect(footer).toContain('href="https://www.tradingview.com/"');
    const about = html.slice(html.indexOf('id="about-dialog"'));
    expect(about).toContain('TradingView Lightweight Charts™');
    expect(about).toContain('href="https://www.tradingview.com/"');
  });

  it('ships the Apache-2.0 licence text with the UI', () => {
    const lic = readFileSync(`${root}/public/licenses/lightweight-charts-LICENSE.txt`, 'utf8');
    expect(lic).toContain('Apache License');
    expect(lic).toContain('Version 2.0');
  });

  it('keeps the chart attribution logo enabled', () => {
    expect(chartSrc).toMatch(/attributionLogo:\s*true/);
    expect(chartSrc).not.toMatch(/attributionLogo:\s*false/);
  });
});
