// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  EXAM,
  EXAM_ENDS_AT,
  EXAM_FORM_URL,
  examOpen,
  examQtyAllowed,
  examResult,
  examSettings,
  examSubmitUrl,
  examTier,
  examTokenValid,
} from '../src/exam.js';

describe('exam settings', () => {
  it('freezes the campaign rules', () => {
    const s = examSettings(300);
    expect(s.startingBalance).toBe(50_000);
    expect(s.profitTarget).toBe(3_000);
    expect(s.trailingDrawdown).toBe(2_000);
    expect(s.trailingDrawdownMode).toBe('static');
    expect(s.dailyLossLimit).toBeNull();
    expect(s.pointValue).toBe(2);
    expect(s.tickSize).toBe(0.25);
    expect(s.practiceTimeframeSeconds).toBe(300);
  });

  it('caps the exam at five contracts', () => {
    expect(EXAM.maxQty).toBe(5);
  });
});

describe('contract cap', () => {
  it('blocks adding exposure past five and always allows exits', () => {
    expect(examQtyAllowed({ positionQty: 0, workingQty: 0, side: 'buy', qty: 5 })).toBe(true);
    expect(examQtyAllowed({ positionQty: 0, workingQty: 0, side: 'buy', qty: 6 })).toBe(false);
    expect(examQtyAllowed({ positionQty: 4, workingQty: 0, side: 'buy', qty: 2 })).toBe(false);
    expect(examQtyAllowed({ positionQty: 1, workingQty: 4, side: 'buy', qty: 1 })).toBe(false);
    // closing a full long is not extra exposure
    expect(examQtyAllowed({ positionQty: 5, workingQty: 0, side: 'sell', qty: 5 })).toBe(true);
    // reducing a short is not extra exposure either
    expect(examQtyAllowed({ positionQty: -5, workingQty: 0, side: 'buy', qty: 5 })).toBe(true);
    // but adding to a short is capped
    expect(examQtyAllowed({ positionQty: -5, workingQty: 0, side: 'sell', qty: 1 })).toBe(false);
  });
});

describe('exam tier', () => {
  it('needs both a small drawdown and a real sample of trades', () => {
    expect(examTier(3_000, 1_000, 10)).toBe('distinction');
    expect(examTier(3_000, 1_001, 25)).toBe('pass');
    expect(examTier(3_000, 200, 9)).toBe('pass');
    expect(examTier(2_999, 100, 20)).toBeNull();
  });
});

describe('exam result', () => {
  it('is deterministic and sends one checksummed code', () => {
    const input = {
      net: 3_050,
      maxDrawdownUsd: 900,
      trades: 12,
      winRatePct: 58.3,
      rrr: 1.8,
      lots: '5',
    };
    const result = examResult(input);
    expect(result).toEqual(examResult(input));
    expect(result.code).toMatch(/^EXAM-v1-[0-9A-F]{8}$/);
    const url = new URL(examSubmitUrl(result));
    expect(url.origin + url.pathname).toBe(EXAM_FORM_URL);
    expect([...url.searchParams.keys()]).toEqual(['usp', 'entry.1153110697']);
    const token = url.searchParams.get('entry.1153110697') ?? '';
    expect(token.split('|').slice(0, 10)).toEqual([
      'KFX1',
      'CD',
      'DIST',
      '3050',
      '900',
      '12',
      '58.3',
      '1.8',
      '5',
      result.code,
    ]);
    expect(examTokenValid(token)).toBe(true);
    const fields = token.split('|');
    expect(examTokenValid([...fields.slice(0, 8), '99', ...fields.slice(9)].join('|'))).toBe(false);
  });
});

describe('campaign window', () => {
  it('closes after the one-week window in HKT', () => {
    expect(examOpen(EXAM_ENDS_AT - 1)).toBe(true);
    expect(examOpen(EXAM_ENDS_AT + 1)).toBe(false);
  });
});
