// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Trademark-neutral public sample ids. Retired ids live only in this alias map
// so an old filename or generator suffix still resolves. Do not render the keys
// in the UI, README, or other user-visible copy.

/** Public ids. Dropdowns, defaults, and docs use these strings. */
export const PUBLIC_SAMPLE_IDS = {
  idx1: 'SYNTH-IDX1',
  idx2: 'SYNTH-IDX2',
  metal1: 'SYNTH-METAL1',
  btc: 'SYNTH-BTC',
  techIdx24hFile: 'SYNTH-TECHIDX-24H',
  techIdx24hSymbol: 'PRACTICE-TECHIDX-24H',
} as const;

/**
 * Retired public id → current public id. Keys are not shown in the UI.
 * `SYNTH-BTC` is unchanged. Near-24h file stems map to `SYNTH-TECHIDX-24H`;
 * the import symbol for that pack is `PRACTICE-TECHIDX-24H` (`SYNTH-` is reserved
 * for the built-in generator).
 */
export const RETIRED_SAMPLE_ID_ALIASES: Readonly<Record<string, string>> = {
  'SYNTH-NQ': PUBLIC_SAMPLE_IDS.idx1,
  'SYNTH-ES': PUBLIC_SAMPLE_IDS.idx2,
  'SYNTH-GC': PUBLIC_SAMPLE_IDS.metal1,
  'SYNTH-BTC': PUBLIC_SAMPLE_IDS.btc,
  'SYNTH-NQ-GLOBEX': PUBLIC_SAMPLE_IDS.techIdx24hFile,
  'SYNTH-NQ_GLOBEX': PUBLIC_SAMPLE_IDS.techIdx24hFile,
  'PRACTICE-NQ-GLOBEX': PUBLIC_SAMPLE_IDS.techIdx24hSymbol,
};

const NEAR_24H_IMPORT = new Set<string>([
  PUBLIC_SAMPLE_IDS.techIdx24hFile,
  PUBLIC_SAMPLE_IDS.techIdx24hSymbol,
]);

/** Exact id, retired or current, folded to the public id. Unknown ids pass through. */
export function canonicalSampleId(id: string): string {
  const key = id.trim().toUpperCase();
  return RETIRED_SAMPLE_ID_ALIASES[key] ?? key;
}

/**
 * Generator name suffix. The price path ignores this string; only the stored
 * symbol changes. Retired suffixes become the public suffix.
 */
export function publicGeneratorSuffix(name: string): string {
  const mapped = RETIRED_SAMPLE_ID_ALIASES[`SYNTH-${name}`];
  if (mapped?.startsWith('SYNTH-')) return mapped.slice('SYNTH-'.length);
  return name;
}

export interface SampleImportSuggestion {
  /** Library title. A retired filename stem is rewritten to the public id. */
  readonly datasetName: string;
  /**
   * Import symbol when this file is the near-24h pack. Other `SYNTH-` ids stay
   * on the dataset title; the generator prefix is reserved and is not an import symbol.
   */
  readonly symbol?: string;
}

interface StemRule {
  readonly from: string;
  readonly to: string;
}

const STEM_RULES: readonly StemRule[] = [
  { from: 'SYNTH-NQ-GLOBEX', to: PUBLIC_SAMPLE_IDS.techIdx24hFile },
  { from: 'SYNTH-NQ_GLOBEX', to: PUBLIC_SAMPLE_IDS.techIdx24hFile },
  { from: 'PRACTICE-NQ-GLOBEX', to: PUBLIC_SAMPLE_IDS.techIdx24hSymbol },
  { from: 'SYNTH-TECHIDX-24H', to: PUBLIC_SAMPLE_IDS.techIdx24hFile },
  { from: 'PRACTICE-TECHIDX-24H', to: PUBLIC_SAMPLE_IDS.techIdx24hSymbol },
  { from: 'SYNTH-NQ', to: PUBLIC_SAMPLE_IDS.idx1 },
  { from: 'SYNTH-ES', to: PUBLIC_SAMPLE_IDS.idx2 },
  { from: 'SYNTH-GC', to: PUBLIC_SAMPLE_IDS.metal1 },
  { from: 'SYNTH-BTC', to: PUBLIC_SAMPLE_IDS.btc },
  { from: 'SYNTH-IDX1', to: PUBLIC_SAMPLE_IDS.idx1 },
  { from: 'SYNTH-IDX2', to: PUBLIC_SAMPLE_IDS.idx2 },
  { from: 'SYNTH-METAL1', to: PUBLIC_SAMPLE_IDS.metal1 },
];

const STEMS_LONGEST_FIRST = [...STEM_RULES].sort((a, b) => b.from.length - a.from.length);

function stemMatches(upper: string, from: string): boolean {
  return upper === from || upper.startsWith(`${from}_`) || upper.startsWith(`${from}-`);
}

/**
 * Default dataset title and import symbol for a sample filename. Returns
 * undefined for files that are not a known sample. Callers should prefer this
 * over showing a retired id in the import form.
 */
export function suggestSampleImport(filenameOrStem: string): SampleImportSuggestion | undefined {
  const leaf = filenameOrStem.split(/[/\\]/).pop() ?? filenameOrStem;
  const base = leaf.replace(/\.[^.]+$/, '').trim();
  const upper = base.toUpperCase();
  for (const rule of STEMS_LONGEST_FIRST) {
    if (!stemMatches(upper, rule.from)) continue;
    const datasetName = `${rule.to}${base.slice(rule.from.length)}`;
    const symbol = NEAR_24H_IMPORT.has(rule.to) ? PUBLIC_SAMPLE_IDS.techIdx24hSymbol : undefined;
    return symbol ? { datasetName, symbol } : { datasetName };
  }
  return undefined;
}
