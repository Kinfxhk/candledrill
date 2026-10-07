// SPDX-License-Identifier: AGPL-3.0-or-later
import { getLang } from './i18n.js';

/** Format Unix seconds as exchange-local "YYYY-MM-DD HH:MM" using a fixed offset. */
export function fmtTime(time: number | null | undefined, utcOffsetMinutes = 0): string {
  if (time === null || time === undefined) return '–';
  return new Date((time + utcOffsetMinutes * 60) * 1000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
}

/** Value for <input type="datetime-local"> in exchange-local time. */
export function toLocalInput(time: number, utcOffsetMinutes = 0): string {
  return new Date((time + utcOffsetMinutes * 60) * 1000).toISOString().slice(0, 16);
}

/** Parse <input type="datetime-local"> (exchange-local) back to Unix seconds. */
export function fromLocalInput(value: string, utcOffsetMinutes = 0): number {
  const ms = Date.parse(`${value}:00Z`);
  return Number.isNaN(ms) ? Number.NaN : ms / 1000 - utcOffsetMinutes * 60;
}

export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const locale = getLang() === 'zh-Hant' ? 'zh-Hant-HK' : 'en-US';
  return v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  return v.toFixed(digits);
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  return `${(v * 100).toFixed(1)}%`;
}

export function signClass(v: number | null | undefined): string {
  if (!v) return '';
  return v > 0 ? 'up' : 'down';
}

export function tfLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}D`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  document.querySelector('.toast')?.remove();
  const t = el(
    'div',
    { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    message,
  );
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4000);
}
