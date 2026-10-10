// SPDX-License-Identifier: AGPL-3.0-or-later
import './styles.css';
import { api, ApiError, sessionsApi, type DatasetRow } from './api.js';
import { applyI18n, setLang, getLang, t, type Lang } from './i18n.js';
import { sessionStatusText } from './labels.js';
import { LibraryView } from './library.js';
import { PracticeView } from './practice.js';
import { el, fmtTime, fromLocalInput, toast } from './format.js';
import { loadBackup, shouldRemind } from './reminder.js';
import {
  dismissForVersion,
  dismissLater,
  loadUpdatePrefs,
  shouldShowUpdate,
  UPDATE_PREFS_KEY,
  type UpdateInfo,
  type UpdatePrefs,
} from './updates.js';

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
  const blind = (form.elements.namedItem('blind') as HTMLInputElement).checked;
  try {
    const view = await sessionsApi.create({
      datasetId: ds.id,
      name: (form.elements.namedItem('name') as HTMLInputElement).value.trim(),
      ...(blind
        ? { blind: true }
        : {
            startTime: fromLocalInput(
              (form.elements.namedItem('start') as HTMLInputElement).value,
              utcOffset,
            ),
          }),
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
    noteChange();
    if (blind) {
      // Next time start with a normal session again (and show the locked preview).
      (form.elements.namedItem('blind') as HTMLInputElement).checked = false;
      form.dispatchEvent(new Event('blind-reset'));
    }
    await openSession(view.session.id);
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

// ------------------------------------------------------------------ backup reminder
const BACKUP_KEY = 'candledrill.backup';
let backupState = loadBackup(localStorage.getItem(BACKUP_KEY));
const saveBackup = () => localStorage.setItem(BACKUP_KEY, JSON.stringify(backupState));
function renderReminder(): void {
  document.getElementById('backup-reminder')!.hidden = !shouldRemind(backupState, Date.now());
}
function noteChange(): void {
  backupState = { ...backupState, changes: backupState.changes + 1 };
  saveBackup();
  renderReminder();
}
function markBackedUp(): void {
  backupState = { lastBackup: Date.now(), dismissedAt: null, changes: 0 };
  saveBackup();
  renderReminder();
}
document.getElementById('btn-backup')!.addEventListener('click', markBackedUp);
document.getElementById('remind-backup')!.addEventListener('click', () => {
  (document.getElementById('btn-backup') as HTMLAnchorElement).click();
});
document.getElementById('remind-dismiss')!.addEventListener('click', () => {
  backupState = { ...backupState, dismissedAt: Date.now() };
  saveBackup();
  renderReminder();
});

// ------------------------------------------------------------------ import / restore
const sessionFile = document.getElementById('session-file') as HTMLInputElement;
document.getElementById('btn-import-session')!.addEventListener('click', () => sessionFile.click());
sessionFile.addEventListener('change', async () => {
  const f = sessionFile.files?.[0];
  sessionFile.value = '';
  if (!f) return;
  const text = await f.text();
  const fail = (err: unknown) => {
    const body =
      err instanceof ApiError ? (err.body as { issues?: string[] } | undefined) : undefined;
    const reason = [(err as Error).message, ...(body?.issues?.slice(0, 3) ?? [])].join(' · ');
    toast(t('lib.importFailed', { reason }), 'error');
  };
  try {
    let view;
    try {
      view = await sessionsApi.importFile(text);
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: string })?.code : undefined;
      const ds = library.selectedDataset;
      if (code !== 'choose-dataset' || !ds || !confirm(t('lib.importChoose', { name: ds.name })))
        throw err;
      view = await sessionsApi.importFile(text, ds.id);
    }
    toast(t('lib.importOk'));
    noteChange();
    await library.reload();
    await openSession(view.session.id);
  } catch (err) {
    fail(err);
  }
});
const restoreFile = document.getElementById('restore-file') as HTMLInputElement;
document.getElementById('btn-restore')!.addEventListener('click', () => restoreFile.click());
restoreFile.addEventListener('change', async () => {
  const f = restoreFile.files?.[0];
  restoreFile.value = '';
  if (!f || !confirm(t('lib.restoreConfirm'))) return;
  try {
    const r = await sessionsApi.restore(await f.arrayBuffer());
    practice.close();
    localStorage.removeItem('candledrill.lastSession');
    toast(
      t('lib.restoreOk', { d: r.datasets, s: r.sessions }) +
        (r.previousCopy ? ` ${t('lib.restoreKept', { path: r.previousCopy })}` : ''),
    );
    await library.reload();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
});

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
        sessionStatusText(s.status),
      );
      const blindBadge = s.blind
        ? el(
            'span',
            { class: 'badge blind', 'data-testid': `blind-${s.id}` },
            t(s.blind === 'hidden' ? 'lib.blindHidden' : 'lib.blindRevealed'),
          )
        : '';
      return el(
        'tr',
        {},
        el('td', {}, s.name),
        el('td', {}, badge, ' ', blindBadge),
        el('td', { class: 'muted' }, fmtTime(Date.parse(s.updatedAt) / 1000)),
        el('td', { class: 'num' }, open, ' ', del),
      );
    }),
  );
}

const library = new LibraryView({ createSession, renderSessions });

function showView(name: 'library' | 'practice'): void {
  if (name === 'library') void renderSessions();
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
  renderUpdateBanner();
  syncAboutUpdateUi();
  document.getElementById('update-check-status')!.textContent = '';
});
const about = document.getElementById('about-dialog') as HTMLDialogElement;
document.getElementById('about-open')!.addEventListener('click', () => {
  syncAboutUpdateUi();
  about.showModal();
});

// ------------------------------------------------------------------ update notice (no auto-download)
let updatePrefs: UpdatePrefs = loadUpdatePrefs(localStorage.getItem(UPDATE_PREFS_KEY));
const saveUpdatePrefs = () => localStorage.setItem(UPDATE_PREFS_KEY, JSON.stringify(updatePrefs));
let latestUpdate: UpdateInfo | null = null;
let currentRelease: string | null = null;

function renderUpdateBanner(): void {
  const banner = document.getElementById('update-banner')!;
  const show = shouldShowUpdate(updatePrefs, latestUpdate, Date.now());
  banner.hidden = !show;
  if (!show || !latestUpdate) return;
  document.getElementById('update-banner-text')!.textContent = t('update.text', {
    latest: latestUpdate.latest,
    current: latestUpdate.current,
  });
  (document.getElementById('update-open') as HTMLAnchorElement).href = latestUpdate.url;
}

function syncAboutUpdateUi(): void {
  (document.getElementById('update-enable') as HTMLInputElement).checked = updatePrefs.checkEnabled;
  const ver = document.getElementById('about-version')!;
  const current = latestUpdate?.current ?? currentRelease;
  ver.textContent = current ? t('update.current', { current }) : '';
}

async function refreshUpdateCheck(opts: { manual?: boolean } = {}): Promise<void> {
  const status = document.getElementById('update-check-status')!;
  if (opts.manual) status.textContent = t('update.checking');
  try {
    const r = await api.updates();
    if (r.available && r.newer && r.latest) {
      latestUpdate = { current: r.current, latest: r.latest, url: r.url, name: r.name };
      if (opts.manual)
        status.textContent = t('update.available', { latest: r.latest, current: r.current });
    } else {
      latestUpdate = null;
      if (opts.manual) {
        status.textContent = r.available
          ? t('update.uptoDate', { current: r.current })
          : t('update.unavailable');
      }
    }
  } catch {
    latestUpdate = null;
    if (opts.manual) status.textContent = t('update.unavailable');
  }
  renderUpdateBanner();
  syncAboutUpdateUi();
}

document.getElementById('update-later')!.addEventListener('click', () => {
  updatePrefs = dismissLater(updatePrefs, Date.now());
  saveUpdatePrefs();
  renderUpdateBanner();
});
document.getElementById('update-dismiss')!.addEventListener('click', () => {
  if (!latestUpdate) return;
  updatePrefs = dismissForVersion(updatePrefs, latestUpdate.latest);
  saveUpdatePrefs();
  renderUpdateBanner();
});
document.getElementById('update-enable')!.addEventListener('change', (ev) => {
  updatePrefs = {
    ...updatePrefs,
    checkEnabled: (ev.target as HTMLInputElement).checked,
  };
  saveUpdatePrefs();
  if (!updatePrefs.checkEnabled) {
    latestUpdate = null;
    renderUpdateBanner();
  } else void refreshUpdateCheck();
});
document.getElementById('update-check-now')!.addEventListener('click', () => {
  void refreshUpdateCheck({ manual: true });
});

renderReminder();
try {
  const health = await api.health();
  if (typeof health.releaseVersion === 'string') currentRelease = health.releaseVersion;
  await library.reload();
  // Resume the last practice session (state is persisted server-side in SQLite).
  const last = Number(localStorage.getItem('candledrill.lastSession'));
  if (last > 0) {
    const { sessions } = await sessionsApi.list();
    if (sessions.some((s) => s.id === last)) await openSession(last);
  }
  if (updatePrefs.checkEnabled) void refreshUpdateCheck();
} catch {
  toast(t('err.network'), 'error');
}
