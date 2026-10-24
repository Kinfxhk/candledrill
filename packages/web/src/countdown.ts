// SPDX-License-Identifier: AGPL-3.0-or-later
// First open of a new practice session: 3 → 2 → 1, then Play. Skip ends it early.
// The same session is not armed again. Fill timing and forming candles are untouched.

import { el } from './format.js';
import { getLang } from './i18n.js';
import type { Lang } from './i18n.js';

/** One second on each number, then the session starts. */
export const COUNTDOWN_STEP_MS = 1000;
export const COUNTDOWN_SEQUENCE = [3, 2, 1] as const;

const PENDING_KEY = 'candledrill.countdownPending';

interface CountdownCopy {
  skip: string;
  label: string;
}

function countdownCopy(lang: Lang): CountdownCopy {
  switch (lang) {
    case 'en':
      return { skip: 'Skip', label: 'Starting practice' };
    case 'zh-Hant':
      return { skip: '跳過', label: '練習即將開始' };
    case 'zh-Hans':
      return { skip: '跳过', label: '练习即将开始' };
    case 'ja':
      return { skip: 'スキップ', label: '練習を開始します' };
    case 'ko':
      return { skip: '건너뛰기', label: '연습 시작' };
    default: {
      const unexpected: never = lang;
      return unexpected;
    }
  }
}

function readPending(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((n): n is number => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function writePending(ids: number[]): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(ids));
  } catch {
    /* quota or private mode: the countdown simply will not arm */
  }
}

/** Arm a countdown for the next open of this newly created session. */
export function markCountdownPending(sessionId: number): void {
  if (!Number.isInteger(sessionId) || sessionId <= 0) return;
  const ids = readPending();
  if (ids.includes(sessionId)) return;
  writePending([...ids, sessionId]);
}

/**
 * True once, on the first open of a session that was armed at creation.
 * Later opens of that same id are not armed.
 */
export function takeCountdownPending(sessionId: number): boolean {
  const ids = readPending();
  if (!ids.includes(sessionId)) return false;
  writePending(ids.filter((id) => id !== sessionId));
  return true;
}

export interface SessionCountdown {
  readonly element: HTMLElement;
  /** Start Play now and hide the countdown. */
  skip(): void;
  /** Hide the countdown and do not start Play (the session was closed). */
  cancel(): void;
  /** Refresh the Skip label after a language change. */
  syncLabel(): void;
}

/**
 * Center-screen 3 → 2 → 1. Each number is a new node so the pop animation restarts.
 * `onComplete` runs after 1 finishes, or immediately when Skip is used.
 * `cancel` does not call `onComplete`.
 */
export function mountCountdown(
  host: HTMLElement,
  opts: { onComplete: () => void; stepMs?: number },
): SessionCountdown {
  const stepMs = opts.stepMs ?? COUNTDOWN_STEP_MS;
  const overlay = el('div', {
    class: 'countdown-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'data-testid': 'countdown',
  });
  const stage = el('div', { class: 'countdown-stage', 'aria-live': 'assertive' });
  const skipBtn = el('button', {
    type: 'button',
    class: 'countdown-skip',
    'data-testid': 'countdown-skip',
  });
  overlay.append(stage, skipBtn);
  host.append(overlay);

  let index = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const syncLabel = (): void => {
    const copy = countdownCopy(getLang());
    skipBtn.textContent = copy.skip;
    overlay.setAttribute('aria-label', copy.label);
  };

  const show = (n: number): void => {
    // A fresh element restarts the CSS animation; updating text alone would not.
    stage.replaceChildren(
      el(
        'div',
        { class: 'countdown-num countdown-pop', 'data-testid': 'countdown-num' },
        String(n),
      ),
    );
  };

  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    overlay.remove();
    opts.onComplete();
  };

  const cancel = (): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    overlay.remove();
  };

  const tick = (): void => {
    if (settled) return;
    const n = COUNTDOWN_SEQUENCE[index];
    if (n === undefined) {
      finish();
      return;
    }
    show(n);
    index += 1;
    timer = setTimeout(tick, stepMs);
  };

  skipBtn.addEventListener('click', () => finish());
  syncLabel();
  tick();
  skipBtn.focus();

  return { element: overlay, skip: finish, cancel, syncLabel };
}
