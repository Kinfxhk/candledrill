// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  dismissForVersion,
  dismissLater,
  isNewer,
  loadUpdatePrefs,
  LATER_QUIET_MS,
  parseVersion,
  shouldShowUpdate,
} from '../src/updates.js';

describe('version compare', () => {
  it('parses plain and v-prefixed tags', () => {
    expect(parseVersion('0.2.5')).toEqual({ major: 0, minor: 2, patch: 5 });
    expect(parseVersion('v0.2.6')).toEqual({ major: 0, minor: 2, patch: 6 });
    expect(parseVersion('V1.0.0-rc.1')).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseVersion('not-a-version')).toBeNull();
  });

  it('detects a newer release and ignores equals / older / garbage', () => {
    expect(isNewer('0.2.5', '0.2.6')).toBe(true);
    expect(isNewer('0.2.5', 'v0.3.0')).toBe(true);
    expect(isNewer('0.2.5', '1.0.0')).toBe(true);
    expect(isNewer('0.2.5', '0.2.5')).toBe(false);
    expect(isNewer('0.2.5', '0.2.4')).toBe(false);
    expect(isNewer('0.2.5', 'oops')).toBe(false);
  });
});

describe('update banner prefs', () => {
  const info = {
    current: '0.2.5',
    latest: '0.2.6',
    url: 'https://github.com/Kinfxhk/candledrill/releases/tag/v0.2.6',
    name: 'CandleDrill v0.2.6',
  };
  const now = 1_700_000_000_000;

  it('defaults to checks on and shows a newer release', () => {
    const prefs = loadUpdatePrefs(null);
    expect(prefs.checkEnabled).toBe(true);
    expect(shouldShowUpdate(prefs, info, now)).toBe(true);
    expect(shouldShowUpdate(prefs, null, now)).toBe(false);
  });

  it('hides after "later" until the quiet window ends', () => {
    const prefs = dismissLater(loadUpdatePrefs(null), now);
    expect(shouldShowUpdate(prefs, info, now + 1)).toBe(false);
    expect(shouldShowUpdate(prefs, info, now + LATER_QUIET_MS)).toBe(true);
  });

  it('hides for the dismissed latest tag, but shows again for a newer one', () => {
    const prefs = dismissForVersion(loadUpdatePrefs(null), '0.2.6');
    expect(shouldShowUpdate(prefs, info, now)).toBe(false);
    expect(shouldShowUpdate(prefs, { ...info, latest: '0.2.7' }, now)).toBe(true);
  });

  it('loads a disabled check preference from storage', () => {
    expect(loadUpdatePrefs(JSON.stringify({ checkEnabled: false })).checkEnabled).toBe(false);
    expect(loadUpdatePrefs('{')).toEqual({
      checkEnabled: true,
      dismissedLatest: null,
      laterUntil: null,
    });
  });
});
