// SPDX-License-Identifier: AGPL-3.0-or-later
// Campaign exam card: a simulated certificate, one-shot score submission, skippable.

import { el, fmtMoney } from './format.js';
import { t } from './i18n.js';
import {
  EXAM,
  EXAM_TIER_LABEL,
  EXAM_VERSION,
  examSubmitUrl,
  readBest,
  readSubmitted,
  markSubmitted,
  type ExamResult,
  type Submitted,
} from './exam.js';

function money(value: number): string {
  return `${value < 0 ? '-' : '+'}$${fmtMoney(Math.abs(value))}`;
}

function row(label: string, value: string): HTMLElement {
  return el('div', { class: 'exam-row' }, el('dt', {}, label), el('dd', {}, value));
}

export function showExamCard(input: {
  readonly result: ExamResult;
  readonly best: ExamResult | null;
  readonly submitted: Submitted | null;
  readonly open: boolean;
  readonly onSubmit: () => void;
}): void {
  const overlay = el('div', {
    class: 'exam-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': t('exam.cert'),
  });

  const cert = el(
    'div',
    { class: 'exam-cert' },
    el('p', { class: 'exam-kicker' }, `Exam 50K · ${EXAM_VERSION}`),
    el(
      'h2',
      { class: 'exam-heading' },
      input.result.tier === 'distinction'
        ? `${t('exam.cert')} · ${t('exam.distinction')}`
        : t('exam.cert'),
    ),
    el('p', { class: 'exam-code' }, input.result.code),
    el(
      'dl',
      { class: 'exam-rows' },
      row(t('exam.net'), money(input.result.net)),
      row(t('exam.maxDd'), `$${fmtMoney(input.result.maxDrawdownUsd)}`),
      row(t('exam.trades'), String(input.result.trades)),
      row(t('exam.maxQty'), String(EXAM.maxQty)),
    ),
    el('p', { class: 'exam-legal' }, t('exam.legal')),
  );

  const submit = el('button', { class: 'primary', type: 'button' }, t('exam.submit'));
  const skip = el('button', { type: 'button' }, t('exam.skip'));
  let timer = 0;

  if (input.submitted !== null) {
    submit.textContent = t('exam.submitted');
    (submit as HTMLButtonElement).disabled = true;
  } else if (!input.open) {
    submit.textContent = t('exam.ended');
    (submit as HTMLButtonElement).disabled = true;
  } else {
    let left = 8;
    (submit as HTMLButtonElement).disabled = true;
    submit.textContent = `${t('exam.submit')} · ${left}s`;
    timer = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        window.clearInterval(timer);
        timer = 0;
        (submit as HTMLButtonElement).disabled = false;
        submit.textContent = t('exam.submit');
        submit.classList.add('exam-ready');
        submit.focus();
        return;
      }
      submit.textContent = `${t('exam.submit')} · ${left}s`;
    }, 1000);
  }

  submit.addEventListener('click', () => {
    if ((submit as HTMLButtonElement).disabled) return;
    (submit as HTMLButtonElement).disabled = true;
    submit.textContent = t('exam.submitted');
    markSubmitted(input.result);
    input.onSubmit();
    window.open(examSubmitUrl(input.result), '_blank', 'noopener');
  });

  const close = (): void => {
    if (timer !== 0) window.clearInterval(timer);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  skip.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);

  const best = input.best ?? readBest();
  overlay.append(cert, el('p', { class: 'exam-note' }, t('exam.once')));
  if (best !== null)
    overlay.append(
      el(
        'p',
        { class: 'exam-best' },
        `${t('exam.best')}: ${best.tier === null ? '—' : EXAM_TIER_LABEL[best.tier]} · ${money(best.net)}`,
      ),
    );
  overlay.append(
    el('div', { class: 'exam-actions' }, submit, skip),
    el('p', { class: 'exam-privacy' }, t('exam.privacy')),
  );
  document.body.append(overlay);
  skip.focus();
}

export { readSubmitted };
