// SPDX-License-Identifier: AGPL-3.0-or-later
// Library card for the campaign's daily round. Delete with daily.ts.

import { el, fmtMoney, tfLabel } from './format.js';
import { t } from './i18n.js';
import { dailyEntry, dailyTimeframe, startDaily, todayDay } from './daily.js';
import { EXAM, examOpen } from './exam.js';

export function mountDailyCard(input: {
  readonly root: HTMLElement;
  readonly open: (sessionId: number) => void;
}): { refresh: () => void } {
  const card = el('section', { class: 'card daily-card', 'data-testid': 'daily-card' });
  input.root.prepend(card);

  const statusText = (day: string): string => {
    const entry = dailyEntry(day);
    if (entry?.result === undefined) return t('daily.fresh');
    const { status, net, maxDrawdown } = entry.result;
    const label =
      status === 'passed'
        ? t('daily.pass')
        : status === 'breached'
          ? t('daily.breach')
          : t('daily.unfinished');
    return `${label} · ${fmtMoney(net)} · ${t('exam.maxDd')} ${fmtMoney(maxDrawdown)}`;
  };

  const draw = (): void => {
    const day = todayDay();
    const played = dailyEntry(day)?.result !== undefined;
    const open = examOpen();
    const button = el(
      'button',
      { type: 'button', class: played ? 'small' : 'small primary' },
      played ? t('daily.played') : t('daily.start'),
    );
    button.disabled = played || !open;
    button.addEventListener('click', () => {
      button.disabled = true;
      void startDaily(day)
        .then((sessionId) => input.open(sessionId))
        .catch((error: unknown) => {
          button.disabled = false;
          const message = error instanceof Error ? error.message : String(error);
          card.append(el('p', { class: 'muted', role: 'alert' }, message));
        });
    });

    card.replaceChildren(
      el('h2', {}, t('daily.title')),
      el('p', { class: 'muted' }, t('exam.note')),
      el(
        'dl',
        { class: 'kv' },
        el('dt', {}, t('daily.date')),
        el('dd', {}, day),
        el('dt', {}, t('daily.timeframe')),
        el('dd', {}, tfLabel(dailyTimeframe(day))),
        el('dt', {}, t('daily.result')),
        el('dd', { 'data-testid': 'daily-result' }, statusText(day)),
      ),
      el(
        'p',
        { class: 'muted' },
        played || !open
          ? open
            ? t('exam.once')
            : t('exam.ended')
          : `${t('exam.maxQty')} ${EXAM.maxQty}`,
      ),
      button,
    );
  };

  draw();
  return { refresh: draw };
}
