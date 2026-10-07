// SPDX-License-Identifier: AGPL-3.0-or-later
import './styles.css';
import { api } from './api.js';
import { applyI18n, setLang, getLang, t, type Lang } from './i18n.js';
import { LibraryView } from './library.js';
import { toast } from './format.js';

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

const library = new LibraryView({});

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
});
document.getElementById('lang-toggle')!.addEventListener('click', () => {
  prefs.lang = getLang() === 'en' ? 'zh-Hant' : 'en';
  setLang(prefs.lang);
  savePrefs();
  applyI18n();
  library.rerender();
});
const about = document.getElementById('about-dialog') as HTMLDialogElement;
document.getElementById('about-open')!.addEventListener('click', () => about.showModal());

try {
  await api.health();
  await library.reload();
} catch {
  toast(t('err.network'), 'error');
}
