// SPDX-License-Identifier: AGPL-3.0-or-later
// Backup reminder (local only, no network). The library lives in one SQLite file on this
// computer; the reminder nudges the user to download a backup now and then.

export interface BackupState {
  lastBackup: number | null;
  dismissedAt: number | null;
  /** New sessions and imports since the last backup. */
  changes: number;
}

export const DAY_MS = 86_400_000;
export const REMIND_AFTER_CHANGES = 3;
export const QUIET_DAYS = 14;

export function loadBackup(raw: string | null): BackupState {
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<BackupState> | null;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    return {
      lastBackup: n(v?.lastBackup),
      dismissedAt: n(v?.dismissedAt),
      changes: Math.max(0, n(v?.changes) ?? 0),
    };
  } catch {
    return { lastBackup: null, dismissedAt: null, changes: 0 };
  }
}

/** Remind after a few changes with no backup and no dismissal in the last QUIET_DAYS days. */
export function shouldRemind(s: BackupState, now: number): boolean {
  if (s.changes < REMIND_AFTER_CHANGES) return false;
  const recent = (t: number | null) => t !== null && now - t >= 0 && now - t < QUIET_DAYS * DAY_MS;
  return !recent(s.lastBackup) && !recent(s.dismissedAt);
}
