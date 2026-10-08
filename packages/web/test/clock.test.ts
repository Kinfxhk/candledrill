// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { practiceClockText } from '../src/clock.js';
import { fmtTime } from '../src/format.js';
import { setLang, zhHant } from '../src/i18n.js';
import { weekdayKeyText, weekdayName } from '../src/labels.js';

const disguised = Date.UTC(2008, 4, 13, 14, 36) / 1000;
const real = Date.UTC(2026, 0, 13, 14, 36) / 1000;
const timeShift = disguised - real;

describe('blind clock', () => {
  const base = {
    cursorTime: disguised,
    startTime: disguised,
    utcOffsetMinutes: 0,
  };

  it('shows day and weekday before reveal, never a calendar date', () => {
    setLang('en');
    const en = practiceClockText({ ...base, blind: { revealed: false, timeShift } });
    expect(en).toBe('Day 1 · Tue 14:36');
    expect(en).not.toMatch(/2008|2026/);
    setLang('zh-Hant');
    const zh = practiceClockText({ ...base, blind: { revealed: false, timeShift } });
    expect(zh).toBe('第 1 日 · 週二 14:36');
    expect(zh).not.toMatch(/Tue|2008|2026/);
    setLang('en');
  });

  it('after reveal matches the banner real time, not the disguised cursor', () => {
    setLang('en');
    const clock = practiceClockText({ ...base, blind: { revealed: true, timeShift } });
    const bannerNow = fmtTime(disguised - timeShift, 0);
    expect(bannerNow).toBe('2026-01-13 14:36');
    expect(clock).toBe(bannerNow);
    expect(clock).not.toBe(fmtTime(disguised, 0));
  });

  it('translates weekday names and leaves English Mon-style keys as Mon', () => {
    setLang('en');
    expect(weekdayName(2)).toBe('Tue');
    expect(weekdayKeyText('Mon')).toBe('Mon');
    expect(weekdayKeyText('09')).toBe('09');
    setLang('zh-Hant');
    expect(weekdayName(2)).toBe('週二');
    expect(weekdayName(0)).toBe('週日');
    expect(weekdayName(1)).toBe('週一');
    expect(weekdayKeyText('Sun')).toBe('週日');
    expect(weekdayKeyText('Mon')).toBe('週一');
    setLang('en');
  });

  it('keeps one set of Traditional Chinese words', () => {
    for (const [key, value] of Object.entries(zhHant)) {
      expect(value, key).not.toMatch(/入市|出市/);
      expect(value, key).not.toMatch(/K 線/);
      expect(value, key).not.toMatch(/\btick\b/i);
    }
    expect(zhHant['pr.longTool']).toBe('好倉 R');
    expect(zhHant['pr.shortTool']).toBe('淡倉 R');
    expect(zhHant['pr.sl']).toContain('跳');
    expect(zhHant['col.rNa']).toBe('不適用：這筆交易有入場未設止蝕，無法計算 R');
    expect(zhHant['lib.previewHint']).toBe(
      '選擇一個數據集作預覽。預覽會顯示整個檔案；練習模式永遠不會顯示未來的K線。',
    );
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const practice = readFileSync(`${root}/packages/web/src/practice.ts`, 'utf8');
    expect(practice).toContain('practiceClockText');
    expect(practice).not.toContain("['Sun', 'Mon'");
    const chart = readFileSync(`${root}/packages/web/src/chart.ts`, 'utf8');
    expect(chart).toContain('weekdayName');
    expect(chart).not.toContain("['Sun', 'Mon'");
  });
});
