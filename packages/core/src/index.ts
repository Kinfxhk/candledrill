// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CandleDrill core engine. Pure functions only: no I/O, no clock, no ambient randomness.

export type * from './types.js';
export { createRng, type Rng } from './rng.js';
export {
  parseIsoDate,
  formatIsoDate,
  weekdayOf,
  parseClock,
  expandSessions,
  isInSession,
  type SessionSpan,
} from './calendar.js';
export { tickDecimals, ticksToPrice, isOnTickGrid, assertTickSize } from './ticks.js';
export {
  validateBars,
  type BarIssue,
  type BarIssueCode,
  type ValidateOptions,
} from './validate.js';
export {
  generateSyntheticBars,
  intradayActivity,
  DEFAULT_SYNTHETIC_CALENDAR,
  SYNTHETIC_GENERATOR_NAME,
  SYNTHETIC_GENERATOR_VERSION,
  SYNTHETIC_SYMBOL_PREFIX,
  MAX_SYNTHETIC_BARS,
  type SyntheticOptions,
  type SyntheticDataset,
} from './synthetic.js';

export {
  importCsv,
  parseCsv,
  parseTimestamp,
  detectDelimiter,
  detectTimeframe,
  guessMapping,
  MAX_IMPORT_BARS,
  type CsvMapping,
  type CsvImportOptions,
  type CsvImportResult,
  type CsvImportReport,
  type CsvRowIssue,
  type CsvTimeFormat,
  type CsvDateOrder,
} from './csv.js';
export {
  aggregateBars,
  bucketStart,
  BarAggregator,
  DAY_SECONDS,
  STANDARD_TIMEFRAMES,
  type AggregateOptions,
} from './aggregate.js';

export { initialCursor, visibleBars, stepsUntil } from './replay.js';
export {
  createSession,
  stepSession,
  jumpSession,
  validateSettings,
  MAX_STEPS_PER_ACTION,
  type SessionSettings,
  type SessionState,
  type SessionStatus,
  type StepResult,
} from './session.js';

export const CANDLEDRILL_RISK_NOTICE_EN =
  'CandleDrill is an educational practice tool. It is not investment advice. ' +
  'Simulated or practice results do not predict real trading results.';
export const CANDLEDRILL_RISK_NOTICE_ZH_HANT =
  'CandleDrill（K線操練場）只作教育及練習用途，並不構成任何投資建議。模擬或練習成績不能預示真實交易結果。';
