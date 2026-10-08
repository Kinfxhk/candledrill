// SPDX-License-Identifier: AGPL-3.0-or-later
// Practice clock. Before a blind reveal it shows "day N · weekday HH:MM" and never a
// calendar date. After reveal it shows the real exchange time (cursor minus timeShift),
// the same instant as the reveal banner. Prices stay disguised; only the clock changes.

import { fmtTime } from './format.js';
import { t } from './i18n.js';
import { weekdayName } from './labels.js';

export interface PracticeClockInput {
  cursorTime: number;
  startTime: number;
  utcOffsetMinutes: number;
  blind?: { revealed: boolean; timeShift?: number } | null | undefined;
}

export function practiceClockText(input: PracticeClockInput): string {
  const off = input.utcOffsetMinutes;
  const blind = input.blind;
  if (blind && !blind.revealed) {
    const local = new Date((input.cursorTime + off * 60) * 1000);
    const day0 = Math.floor((input.startTime + off * 60) / 86_400);
    const n = Math.floor((input.cursorTime + off * 60) / 86_400) - day0 + 1;
    const hm = local.toISOString().slice(11, 16);
    return `${t('pr.blindDay', { n })} · ${weekdayName(local.getUTCDay())} ${hm}`;
  }
  const shown =
    blind?.revealed && blind.timeShift !== undefined
      ? input.cursorTime - blind.timeShift
      : input.cursorTime;
  return fmtTime(shown, off);
}
