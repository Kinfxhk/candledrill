// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tickDecimals } from '@candledrill/core';
import { en, setLang, t, zhHant } from '../src/i18n.js';
import {
  exitReasonText,
  orderRoleText,
  orderTypeText,
  sessionStatusText,
  statusReasonText,
} from '../src/labels.js';
import { decimals } from '../src/side.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));

describe('review 2026-10-08 labels', () => {
  it('translates engine tokens in both languages and does not leave the raw English', () => {
    setLang('en');
    expect(exitReasonText('stop-loss')).toBe('Stop-loss');
    expect(exitReasonText('take-profit')).toBe('Take-profit');
    expect(exitReasonText('flatten')).toBe('Flatten');
    expect(exitReasonText('rule')).toBe('Practice rule');
    expect(exitReasonText('manual')).toBe('Manual');
    expect(orderTypeText('market')).toBe('Market');
    expect(orderTypeText('limit')).toBe('Limit');
    expect(orderTypeText('stop')).toBe('Stop');
    expect(orderRoleText('stop-loss')).toBe('Stop-loss');
    expect(sessionStatusText('active')).toBe('Active');
    expect(sessionStatusText('breached')).toBe('Breached');
    expect(statusReasonText('daily loss limit 300')).toBe('daily loss limit 300');
    expect(statusReasonText('trailing drawdown 500')).toBe('trailing drawdown 500');
    expect(statusReasonText('profit target 1000')).toBe('profit target 1000');
    expect(statusReasonText('end of data')).toBe('end of data');

    setLang('zh-Hant');
    expect(exitReasonText('stop-loss')).toBe('止蝕');
    expect(exitReasonText('take-profit')).toBe('止賺');
    expect(exitReasonText('flatten')).toBe('全部平倉');
    expect(exitReasonText('rule')).toBe('練習規則');
    expect(orderTypeText('market')).toBe('市價');
    expect(orderTypeText('limit')).toBe('限價');
    expect(orderTypeText('stop')).toBe('觸價單');
    expect(orderRoleText('entry')).toBe('入場');
    expect(sessionStatusText('active')).toBe('進行中');
    expect(sessionStatusText('breached')).toBe('已觸發');
    expect(sessionStatusText('passed')).toBe('已達標');
    expect(sessionStatusText('finished')).toBe('已完成');
    expect(statusReasonText('daily loss limit 300')).toBe('每日虧損上限 300');
    expect(statusReasonText('trailing drawdown 500')).toBe('追蹤回撤 500');
    expect(statusReasonText('profit target 1000')).toBe('盈利目標 1000');
    expect(statusReasonText('end of data')).toBe('已到數據尾');
    expect(statusReasonText('daily loss limit 300')).not.toMatch(/daily loss/);
    expect(exitReasonText('stop-loss')).not.toBe('stop-loss');
    // Unknown tokens stay visible rather than disappearing.
    expect(exitReasonText('other')).toBe('other');
    expect(statusReasonText('custom note')).toBe('custom note');
    setLang('en');
  });

  it('fixes the two Traditional Chinese copy bugs and states the bar-close rule', () => {
    setLang('zh-Hant');
    expect(t('col.rNa')).toBe('不適用：這筆交易有入場未設止蝕，無法計算 R');
    expect(zhHant['col.rNa']).not.toMatch(/先可/);
    expect(t('lib.previewHint')).toMatch(/^選擇一個數據集作預覽/);
    expect(zhHant['lib.previewHint']).not.toMatch(/揀/);
    expect(t('pr.rulesBar')).toMatch(/每根K線收市/);
    expect(t('pr.bracketHint')).toMatch(/最後收市價/);
    expect(t('pr.realizedHint')).toMatch(/入場手續費/);
    expect(t('imp.tickHint')).toMatch(/0\.01/);
    expect(t('lib.tick', { n: 0.25 })).toBe('最小跳動 0.25');
    setLang('en');
    expect(en['pr.rulesBar']).toMatch(/bar closes/);
    expect(en['pr.bracketHint']).toMatch(/last close/);
    expect(en['imp.tickHint']).toMatch(/0\.01/);
    expect(t('lib.tick', { n: 0.01 })).toBe('tick 0.01');
  });

  it('shares one decimal count with the price axis', () => {
    for (const tick of [0.25, 0.025, 0.125, 0.1, 0.01, 0.005])
      expect(decimals(tick)).toBe(tickDecimals(tick));
  });

  it('wires the translators into the screens that used to print raw tokens', () => {
    const read = (rel: string) => readFileSync(`${root}/${rel}`, 'utf8');
    const bottom = read('packages/web/src/bottom.ts');
    expect(bottom).toContain('exitReasonText(tr.exitReason)');
    expect(bottom).not.toMatch(/\{\}, tr\.exitReason\)/);
    expect(bottom).toContain('orderRoleText(f.role)');
    const side = read('packages/web/src/side.ts');
    expect(side).toContain('orderTypeText(o.type)');
    expect(side).not.toContain('${o.type}');
    expect(side).toContain('tickDecimals(tick)');
    const main = read('packages/web/src/main.ts');
    expect(main).toContain('sessionStatusText(s.status)');
    const practice = read('packages/web/src/practice.ts');
    expect(practice).toContain('statusReasonText(this.state.statusReason)');
    const chart = read('packages/web/src/chart.ts');
    expect(chart).toContain('const precision = tickDecimals(tickSize)');
    expect(chart).not.toContain('Math.log10');
    const css = read('packages/web/src/styles.css');
    expect(css).toMatch(/header\.app \{[^}]*flex-wrap:\s*wrap/s);
    const html = read('packages/web/index.html');
    expect(html).toContain('data-i18n="pr.rulesBar"');
    expect(html).toContain('data-i18n="imp.tickHint"');
    const readme = read('README.md');
    expect(readme).toMatch(/desktop browser/i);
    expect(readme).toMatch(/桌面瀏覽器/);
  });

  it('Python price-axis check round-trips the displayed price', () => {
    const script = `${root}/tools/oracle/price_axis.py`;
    let ran: ReturnType<typeof spawnSync> | undefined;
    for (const bin of ['python3', 'python']) {
      const result = spawnSync(bin, [script], { encoding: 'utf8' });
      if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      ran = result;
      break;
    }
    expect(ran, 'python3 or python is required').toBeDefined();
    const detail = [ran!.stderr, ran!.stdout].map((s) => (typeof s === 'string' ? s : '')).join('');
    expect(ran!.status, detail).toBe(0);
    expect(ran!.stdout).toMatch(/round-trip/);
  });
});
