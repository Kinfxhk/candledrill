// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  PUBLIC_SAMPLE_IDS,
  RETIRED_SAMPLE_ID_ALIASES,
  SYNTHETIC_SYMBOL_PREFIX,
  canonicalSampleId,
  generateSyntheticBars,
  publicGeneratorSuffix,
  suggestSampleImport,
} from '../src/index.js';

const base = { seed: 20261007, startDate: '2026-10-05', days: 2 } as const;

describe('retired sample id aliases', () => {
  it('maps the canonical public ids and leaves BTC unchanged', () => {
    expect(RETIRED_SAMPLE_ID_ALIASES).toEqual({
      'SYNTH-NQ': 'SYNTH-IDX1',
      'SYNTH-ES': 'SYNTH-IDX2',
      'SYNTH-GC': 'SYNTH-METAL1',
      'SYNTH-BTC': 'SYNTH-BTC',
      'SYNTH-NQ-GLOBEX': 'SYNTH-TECHIDX-24H',
      'SYNTH-NQ_GLOBEX': 'SYNTH-TECHIDX-24H',
      'PRACTICE-NQ-GLOBEX': 'PRACTICE-TECHIDX-24H',
    });
    expect(canonicalSampleId('synth-nq')).toBe(PUBLIC_SAMPLE_IDS.idx1);
    expect(canonicalSampleId('SYNTH-ES')).toBe(PUBLIC_SAMPLE_IDS.idx2);
    expect(canonicalSampleId('SYNTH-GC')).toBe(PUBLIC_SAMPLE_IDS.metal1);
    expect(canonicalSampleId('SYNTH-BTC')).toBe(PUBLIC_SAMPLE_IDS.btc);
    expect(canonicalSampleId('PRACTICE-NQ-GLOBEX')).toBe(PUBLIC_SAMPLE_IDS.techIdx24hSymbol);
    expect(canonicalSampleId('SYNTH-DEMO')).toBe('SYNTH-DEMO');
  });

  it('rewrites a retired generator suffix without changing the price path', () => {
    expect(publicGeneratorSuffix('NQ')).toBe('IDX1');
    expect(publicGeneratorSuffix('ES')).toBe('IDX2');
    expect(publicGeneratorSuffix('GC')).toBe('METAL1');
    expect(publicGeneratorSuffix('BTC')).toBe('BTC');
    expect(publicGeneratorSuffix('NQ-GLOBEX')).toBe('TECHIDX-24H');
    expect(publicGeneratorSuffix('NQ_GLOBEX')).toBe('TECHIDX-24H');
    expect(publicGeneratorSuffix('DEMO')).toBe('DEMO');
    expect(publicGeneratorSuffix('ES_LIKE')).toBe('ES_LIKE');

    const retired = generateSyntheticBars({ ...base, name: 'NQ' });
    const current = generateSyntheticBars({ ...base, name: 'IDX1' });
    expect(retired.meta.symbol).toBe(`${SYNTHETIC_SYMBOL_PREFIX}IDX1`);
    expect(retired.bars).toEqual(current.bars);
    expect(generateSyntheticBars({ ...base, name: 'ES' }).meta.symbol).toBe('SYNTH-IDX2');
    expect(generateSyntheticBars({ ...base, name: 'GC' }).meta.symbol).toBe('SYNTH-METAL1');
    expect(generateSyntheticBars({ ...base, name: 'BTC' }).meta.symbol).toBe('SYNTH-BTC');
    expect(generateSyntheticBars({ ...base, name: 'NQ-GLOBEX' }).meta.symbol).toBe(
      'SYNTH-TECHIDX-24H',
    );
  });

  it('suggests the public near-24h import symbol for old and new filenames', () => {
    expect(suggestSampleImport('SYNTH-NQ-GLOBEX_1min.csv')).toEqual({
      datasetName: 'SYNTH-TECHIDX-24H_1min',
      symbol: 'PRACTICE-TECHIDX-24H',
    });
    expect(suggestSampleImport('samples/SYNTH-NQ-GLOBEX_14d_1min.csv')).toEqual({
      datasetName: 'SYNTH-TECHIDX-24H_14d_1min',
      symbol: 'PRACTICE-TECHIDX-24H',
    });
    expect(suggestSampleImport('SYNTH-TECHIDX-24H_1min.csv')).toEqual({
      datasetName: 'SYNTH-TECHIDX-24H_1min',
      symbol: 'PRACTICE-TECHIDX-24H',
    });
    expect(suggestSampleImport('PRACTICE-NQ-GLOBEX.csv')?.symbol).toBe('PRACTICE-TECHIDX-24H');
    expect(suggestSampleImport('SYNTH-NQ_1min.csv')).toEqual({ datasetName: 'SYNTH-IDX1_1min' });
    expect(suggestSampleImport('SYNTH-ES.csv')).toEqual({ datasetName: 'SYNTH-IDX2' });
    expect(suggestSampleImport('SYNTH-GC.csv')).toEqual({ datasetName: 'SYNTH-METAL1' });
    expect(suggestSampleImport('SYNTH-BTC_1min.csv')).toEqual({ datasetName: 'SYNTH-BTC_1min' });
    expect(suggestSampleImport('my-bars.csv')).toBeUndefined();
  });
});
