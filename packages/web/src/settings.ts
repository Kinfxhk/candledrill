// SPDX-License-Identifier: AGPL-3.0-or-later
// User preferences for the practice screen (chart look, ticket defaults, confirmations) and
// the user's rule profiles. Both stay in this browser (localStorage); export/import as JSON.

import { blankProfile, parseProfile, profileIssues, type RuleProfile } from '@candledrill/core';

export const SETTINGS_KEY = 'candledrill.settings.v1';
export const PROFILES_KEY = 'candledrill.profiles.v1';

export interface UiSettings {
  upColor: string;
  downColor: string;
  grid: boolean;
  volume: boolean;
  qtyPresets: number[];
  defaultSl: number | null;
  defaultTp: number | null;
  confirmFlatten: boolean;
  /** Auto break-even trigger in ticks (null = off) and offset beyond entry. */
  breakEvenTicks: number | null;
  breakEvenOffset: number;
  /** Trailing stop distance in ticks (null = off). */
  trailTicks: number | null;
  /** Show the stop / target the ticket would place as dashed lines before you submit. */
  previewBracket: boolean;
  /** Drawing magnet: snap clicks and drags to the nearest open/high/low/close. */
  magnet: boolean;
  /** Keyboard bindings: action -> key (KeyboardEvent.key, lower case). */
  keys: Record<HotkeyAction, string>;
}

export type HotkeyAction =
  'step' | 'back' | 'play' | 'buy' | 'sell' | 'flatten' | 'checkpoint' | 'slower' | 'faster';

export const DEFAULT_KEYS: Record<HotkeyAction, string> = {
  step: 'arrowright',
  back: 'arrowleft',
  play: ' ',
  buy: 'b',
  sell: 's',
  flatten: 'f',
  checkpoint: 'p',
  slower: '[',
  faster: ']',
};

export const DEFAULT_SETTINGS: UiSettings = {
  upColor: '',
  downColor: '',
  grid: true,
  volume: true,
  qtyPresets: [1, 2, 5],
  defaultSl: null,
  defaultTp: null,
  confirmFlatten: false,
  breakEvenTicks: null,
  breakEvenOffset: 0,
  trailTicks: null,
  previewBracket: true,
  magnet: false,
  keys: DEFAULT_KEYS,
};

const HEX = /^#[0-9a-f]{6}$/i;
const posIntOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000 ? v : null;

/** Read settings, keeping only valid values (never throws on junk). */
export function loadSettings(raw: string | null): UiSettings {
  let o: Record<string, unknown> = {};
  try {
    const p = raw ? (JSON.parse(raw) as unknown) : null;
    if (p && typeof p === 'object' && !Array.isArray(p)) o = p as Record<string, unknown>;
  } catch {
    /* keep defaults */
  }
  const presets = Array.isArray(o.qtyPresets)
    ? o.qtyPresets
        .map(posIntOrNull)
        .filter((x): x is number => x !== null)
        .slice(0, 5)
    : DEFAULT_SETTINGS.qtyPresets;
  return {
    upColor: typeof o.upColor === 'string' && HEX.test(o.upColor) ? o.upColor : '',
    downColor: typeof o.downColor === 'string' && HEX.test(o.downColor) ? o.downColor : '',
    grid: typeof o.grid === 'boolean' ? o.grid : DEFAULT_SETTINGS.grid,
    volume: typeof o.volume === 'boolean' ? o.volume : DEFAULT_SETTINGS.volume,
    qtyPresets: presets.length ? presets : DEFAULT_SETTINGS.qtyPresets,
    defaultSl: posIntOrNull(o.defaultSl),
    defaultTp: posIntOrNull(o.defaultTp),
    confirmFlatten:
      typeof o.confirmFlatten === 'boolean' ? o.confirmFlatten : DEFAULT_SETTINGS.confirmFlatten,
    breakEvenTicks: posIntOrNull(o.breakEvenTicks),
    breakEvenOffset:
      typeof o.breakEvenOffset === 'number' &&
      Number.isInteger(o.breakEvenOffset) &&
      o.breakEvenOffset >= 0 &&
      o.breakEvenOffset <= 1000
        ? o.breakEvenOffset
        : 0,
    trailTicks: posIntOrNull(o.trailTicks),
    previewBracket:
      typeof o.previewBracket === 'boolean' ? o.previewBracket : DEFAULT_SETTINGS.previewBracket,
    magnet: typeof o.magnet === 'boolean' ? o.magnet : DEFAULT_SETTINGS.magnet,
    keys: loadKeys(o.keys),
  };
}

/** Keep valid single-key bindings; a key bound twice keeps only its first action. */
function loadKeys(raw: unknown): Record<HotkeyAction, string> {
  const out = { ...DEFAULT_KEYS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const used = new Set<string>();
  for (const a of Object.keys(DEFAULT_KEYS) as HotkeyAction[]) {
    const v = (raw as Record<string, unknown>)[a];
    if (typeof v === 'string' && v.length >= 1 && v.length <= 12 && !used.has(v.toLowerCase()))
      out[a] = v.toLowerCase();
    used.add(out[a]);
  }
  return out;
}

/** The action bound to a key event, or null. Shift+step = +10 is handled by the caller. */
export function hotkeyAction(key: string, keys: Record<HotkeyAction, string>): HotkeyAction | null {
  const k = key.toLowerCase();
  for (const a of Object.keys(keys) as HotkeyAction[]) if (keys[a] === k) return a;
  return null;
}

let current: UiSettings = DEFAULT_SETTINGS;
const listeners = new Set<(s: UiSettings) => void>();

export function initSettings(storage: Pick<Storage, 'getItem'> = localStorage): UiSettings {
  current = loadSettings(storage.getItem(SETTINGS_KEY));
  return current;
}
export function getSettings(): UiSettings {
  return current;
}
export function saveSettings(next: UiSettings, storage: Pick<Storage, 'setItem'> = localStorage) {
  current = loadSettings(JSON.stringify(next));
  storage.setItem(SETTINGS_KEY, JSON.stringify(current));
  for (const l of listeners) l(current);
}
export function onSettings(fn: (s: UiSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ------------------------------------------------------------------ rule profiles
export function loadProfiles(raw: string | null): RuleProfile[] {
  try {
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((p) => profileIssues(p).length === 0) as RuleProfile[];
  } catch {
    return [];
  }
}
export function readProfiles(storage: Pick<Storage, 'getItem'> = localStorage): RuleProfile[] {
  return loadProfiles(storage.getItem(PROFILES_KEY));
}
export function writeProfiles(
  list: RuleProfile[],
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(PROFILES_KEY, JSON.stringify(list));
}
export function newProfileId(): string {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return `p${a[0]!.toString(36)}${a[1]!.toString(36)}`.slice(0, 40);
}
export function newProfile(name: string): RuleProfile {
  return blankProfile(newProfileId(), name);
}
/** Import a profile file; a clashing id gets a fresh one so nothing is overwritten. */
export function importProfile(
  text: string,
  existing: RuleProfile[],
): { profile?: RuleProfile; issues: string[] } {
  const r = parseProfile(text);
  if (!r.profile) return r;
  const profile = existing.some((p) => p.id === r.profile!.id)
    ? { ...r.profile, id: newProfileId() }
    : r.profile;
  return { profile, issues: [] };
}

/** Which profile each session uses (session id -> profile snapshot taken at start). */
export const SESSION_PROFILE_KEY = 'candledrill.sessionProfiles.v1';
export function sessionProfile(
  sessionId: number,
  storage: Pick<Storage, 'getItem'> = localStorage,
): RuleProfile | null {
  try {
    const map = JSON.parse(storage.getItem(SESSION_PROFILE_KEY) ?? '{}') as Record<string, unknown>;
    const p = map[String(sessionId)];
    return p && profileIssues(p).length === 0 ? (p as RuleProfile) : null;
  } catch {
    return null;
  }
}
export function setSessionProfile(
  sessionId: number,
  profile: RuleProfile | null,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): void {
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(storage.getItem(SESSION_PROFILE_KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    map = {};
  }
  if (profile) map[String(sessionId)] = profile;
  else delete map[String(sessionId)];
  storage.setItem(SESSION_PROFILE_KEY, JSON.stringify(map));
}

/** Per-session hidden / locked drawing ids (UI state, not part of the session file). */
export const DRAWING_FLAGS_KEY = 'candledrill.drawingFlags.v1';
export interface DrawingFlags {
  hidden: string[];
  locked: string[];
}
export function readDrawingFlags(sessionId: number): DrawingFlags {
  try {
    const all = JSON.parse(localStorage.getItem(DRAWING_FLAGS_KEY) ?? '{}') as Record<
      string,
      DrawingFlags
    >;
    const f = all[String(sessionId)];
    return {
      hidden: Array.isArray(f?.hidden) ? f.hidden.filter((x) => typeof x === 'string') : [],
      locked: Array.isArray(f?.locked) ? f.locked.filter((x) => typeof x === 'string') : [],
    };
  } catch {
    return { hidden: [], locked: [] };
  }
}
export function writeDrawingFlags(sessionId: number, flags: DrawingFlags): void {
  let all: Record<string, DrawingFlags>;
  try {
    all = JSON.parse(localStorage.getItem(DRAWING_FLAGS_KEY) ?? '{}') as Record<
      string,
      DrawingFlags
    >;
  } catch {
    all = {};
  }
  all[String(sessionId)] = flags;
  localStorage.setItem(DRAWING_FLAGS_KEY, JSON.stringify(all));
}
