// SPDX-License-Identifier: AGPL-3.0-or-later
// Local macro document and the simulated-macro feature flag. Not part of session state.

import { exampleOrbSmaMacro, parseMacro, type MacroV1 } from '@candledrill/core';

const MACRO_KEY = 'candledrill.macros.v1';
const FLAG_KEY = 'candledrill.feature.macro';

/** Default on. Set the flag to "0" to hide the simulated macro panel. */
export function macroFeatureEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setMacroFeatureEnabled(on: boolean): void {
  localStorage.setItem(FLAG_KEY, on ? '1' : '0');
}

export function loadMacro(): MacroV1 {
  try {
    const raw = localStorage.getItem(MACRO_KEY);
    if (raw) return parseMacro(JSON.parse(raw));
  } catch {
    // A broken document falls back to the example. The manual ticket is unaffected.
  }
  return exampleOrbSmaMacro();
}

export function saveMacro(macro: MacroV1): void {
  localStorage.setItem(MACRO_KEY, JSON.stringify(parseMacro(macro)));
}
