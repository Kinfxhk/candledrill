// SPDX-License-Identifier: AGPL-3.0-or-later
// Client prefs for the optional "new version available" banner. The actual GitHub lookup
// happens on the local server (/api/updates); this module only decides whether to show it.

export const UPDATE_PREFS_KEY = 'candledrill.updates';
export const LATER_QUIET_MS = 7 * 86_400_000;

export interface UpdatePrefs {
  /** When false, the app does not ask the server on load. Manual check still works. */
  checkEnabled: boolean;
  /** Latest release tag the user chose "don't show for this version" for. */
  dismissedLatest: string | null;
  /** "Remind me later" timestamp; banner stays hidden until LATER_QUIET_MS passes. */
  laterUntil: number | null;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  name: string | null;
}

export function loadUpdatePrefs(raw: string | null): UpdatePrefs {
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<UpdatePrefs> | null;
    return {
      checkEnabled: v?.checkEnabled !== false,
      dismissedLatest:
        typeof v?.dismissedLatest === 'string' && v.dismissedLatest.trim()
          ? v.dismissedLatest.trim()
          : null,
      laterUntil:
        typeof v?.laterUntil === 'number' && Number.isFinite(v.laterUntil) ? v.laterUntil : null,
    };
  } catch {
    return { checkEnabled: true, dismissedLatest: null, laterUntil: null };
  }
}

export function shouldShowUpdate(
  prefs: UpdatePrefs,
  info: UpdateInfo | null,
  now: number,
): boolean {
  if (!info) return false;
  if (prefs.dismissedLatest !== null && prefs.dismissedLatest === info.latest) return false;
  if (prefs.laterUntil !== null && now < prefs.laterUntil) return false;
  return true;
}

export function dismissLater(prefs: UpdatePrefs, now: number): UpdatePrefs {
  return { ...prefs, laterUntil: now + LATER_QUIET_MS };
}

export function dismissForVersion(prefs: UpdatePrefs, latest: string): UpdatePrefs {
  return { ...prefs, dismissedLatest: latest, laterUntil: null };
}

/** Parse "0.2.5" / "v0.2.5" for client-side sanity checks and tests. */
export function parseVersion(raw: string): { major: number; minor: number; patch: number } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function isNewer(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  if (b.major !== a.major) return b.major > a.major;
  if (b.minor !== a.minor) return b.minor > a.minor;
  return b.patch > a.patch;
}
