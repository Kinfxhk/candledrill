// SPDX-License-Identifier: AGPL-3.0-or-later
import './styles.css';
import { api, sessionsApi, type DatasetRow } from './api.js';
import { applyI18n, setLang, getLang, t, type Lang } from './i18n.js';
import { LibraryView } from './library.js';
import { PracticeView } from './practice.js';
import { el, fmtTime, fromLocalInput, toast } from './format.js';

const PREFS_KEY = 'candledrill.prefs';
interface Prefs {
  lang: Lang;
  theme: 'dark' | 'light';
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    const lang: Lang =
      p.lang === 'zh-Hant' || p.lang === 'en'
        ? p.lang
        : navigator.language.startsWith('zh')
          ? 'zh-Hant'
          : 'en';
    const theme =
      p.theme === 'light' || p.theme === 'dark'
        ? p.theme
        : matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark';
    return { lang, theme };
  } catch {
    return { lang: 'en', theme: 'dark' };
  }
}
const prefs = loadPrefs();
const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));

document.documentElement.dataset.theme = prefs.theme;
setLang(prefs.lang);
applyI18n();

const practice = new PracticeView(() => {});

function num(form: HTMLFormElement, name: string): number | null {
  const v = (form.elements.namedItem(name) as HTMLInputElement).value.trim();
  return v === '' ? null : Number(v);
}

async function createSession(ds: DatasetRow, form: HTMLFormElement): Promise<void> {
  const utcOffset = num(form, 'utcOffset') ?? 0;
  const [hh, mm] = (
    (form.elements.namedItem('dayStart') as HTMLInputElement).value || '00:00'
  ).split(':');
  try {
    const view = await sessionsApi.create({
      datasetId: ds.id,
      name: (form.elements.namedItem('name') as HTMLInputElement).value.trim(),
      startTime: fromLocalInput(
        (form.elements.namedItem('start') as HTMLInputElement).value,
        utcOffset,
      ),
      settings: {
        tickSize: num(form, 'tickSize') ?? ds.tickSize,
        pointValue: num(form, 'pointValue') ?? 1,
        commissionPerContract: num(form, 'commission') ?? 0,
        slippageTicks: num(form, 'slippage') ?? 0,
        startingBalance: num(form, 'balance') ?? 50000,
        dailyLossLimit: num(form, 'dailyLoss'),
        trailingDrawdown: num(form, 'trailing'),
        profitTarget: num(form, 'target'),
        utcOffsetMinutes: utcOffset,
        dayStartMinutes: Number(hh) * 60 + Number(mm),
      },
    });
    await openSession(view.session.id);
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function openSession(id: number): Promise<void> {
  showView('practice');
  await practice.open(id);
}

async function renderSessions(): Promise<void> {
  const { sessions } = await sessionsApi.list();
  const tbody = document.querySelector('#session-table tbody')!;
  document.getElementById('session-empty')!.hidden = sessions.length > 0;
  tbody.replaceChildren(
    ...sessions.map((s) => {
      const open = el(
        'button',
        { type: 'button', class: 'small', 'data-testid': `open-session-${s.id}` },
        t('lib.open'),
      );
      open.addEventListener('click', () => void openSession(s.id));
      const del = el('button', { type: 'button', class: 'small ghost' }, t('lib.delete'));
      del.addEventListener('click', async () => {
        if (!confirm(t('lib.delete') + '?')) return;
        await sessionsApi.remove(s.id);
        if (practice.sessionId === s.id) practice.close();
        await renderSessions();
      });
      const badge = el(
        'span',
        { class: `badge ${s.status === 'breached' ? 'bad' : s.status === 'passed' ? 'ok' : ''}` },
        s.status,
      );
      return el(
        'tr',
        {},
        el('td', {}, s.name),
        el('td', {}, badge),
        el('td', { class: 'muted' }, fmtTime(Date.parse(s.updatedAt) / 1000)),
        el('td', { class: 'num' }, open, ' ', del),
      );
    }),
  );
}

const library = new LibraryView({ createSession, renderSessions });

function showView(name: 'library' | 'practice'): void {
  document
    .querySelectorAll<HTMLElement>('.view')
    .forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll<HTMLButtonElement>('nav.tabs button').forEach((b) => {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}
document
  .querySelectorAll<HTMLButtonElement>('nav.tabs button')
  .forEach((b) =>
    b.addEventListener('click', () => showView(b.dataset.view as 'library' | 'practice')),
  );

document.getElementById('theme-toggle')!.addEventListener('click', () => {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = prefs.theme;
  savePrefs();
  library.applyTheme();
  practice.applyTheme();
});
document.getElementById('lang-toggle')!.addEventListener('click', () => {
  prefs.lang = getLang() === 'en' ? 'zh-Hant' : 'en';
  setLang(prefs.lang);
  savePrefs();
  applyI18n();
  library.rerender();
  practice.render();
});
const about = document.getElementById('about-dialog') as HTMLDialogElement;
document.getElementById('about-open')!.addEventListener('click', () => about.showModal());

try {
  await api.health();
  await library.reload();
  // Resume the last practice session (state is persisted server-side in SQLite).
  const last = Number(localStorage.getItem('candledrill.lastSession'));
  if (last > 0) {
    const { sessions } = await sessionsApi.list();
    if (sessions.some((s) => s.id === last)) await openSession(last);
  }
} catch {
  toast(t('err.network'), 'error');
}
