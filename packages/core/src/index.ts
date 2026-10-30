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
  DAILY_FORMING_CALENDAR,
  syntheticCalendar,
  SYNTHETIC_GENERATOR_NAME,
  SYNTHETIC_GENERATOR_VERSION,
  SYNTHETIC_SYMBOL_PREFIX,
  MAX_SYNTHETIC_BARS,
  type SyntheticOptions,
  type SyntheticDataset,
} from './synthetic.js';
export {
  canonicalSampleId,
  publicGeneratorSuffix,
  suggestSampleImport,
  PUBLIC_SAMPLE_IDS,
  RETIRED_SAMPLE_ID_ALIASES,
  type SampleImportSuggestion,
} from './sample-ids.js';

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
export {
  FORMING_PARTS,
  DEFAULT_DEMO_SESSION_SECONDS,
  demoSessionSeconds,
  formingSourceSeconds,
  pairedPracticeTimeframe,
  defaultPracticeTimeframe,
  resolvePracticeTimeframe,
  practiceChartTimeframes,
  isSyntheticTimeframe,
} from './forming.js';

export { initialCursor, visibleBars, stepsUntil } from './replay.js';
export {
  forgetTapeAfter,
  isPracticeClose,
  MAX_FRAME_SOURCE_BARS,
  noteTape,
  practiceAggregateOptions,
  practiceFrames,
  previousPracticeCursor,
  replayCursorForBarTime,
  tapeAtOrBefore,
  TAPE_CAP,
} from './practice-cursor.js';
export {
  ENGINE_VERSION,
  FILL_MODEL_VERSION,
  lossRuleBasisFor,
  simulationPolicyFor,
  SIMULATION_POLICY,
  type SimulationPolicy,
} from './policy.js';
export {
  createSession,
  costModel,
  sessionPlaceOrder,
  sessionCancelOrder,
  sessionModifyOrder,
  sessionFlatten,
  sessionEquity,
  liquidationEquity,
  estimatedExitCost,
  sessionStats,
  ruleStatus,
  upgradeState,
  normalizeSettings,
  equityAtPrice,
  trailingPeak,
  trailingFloor,
  TRAILING_DRAWDOWN_MODES,
  dayKeyOf,
  type RuleStatus,
  FILL_MODEL_NOTE,
  END_OF_DATA_MESSAGE,
  stepSession,
  jumpSession,
  validateSettings,
  MAX_STEPS_PER_ACTION,
  type SessionSettings,
  type TrailingDrawdownMode,
  type SessionState,
  type SessionStatus,
  type StepResult,
} from './session.js';

export {
  placeOrder,
  cancelOrder,
  cancelAllWorking,
  modifyOrder,
  flattenAll,
  processBar,
  applyFill,
  forceClose,
  triggerOf,
  roundToTick,
  emptyTrading,
  unrealizedPnl,
  workingOrders,
  OrderError,
  MAX_ORDER_QTY,
  type Order,
  type OrderRequest,
  type OrderChange,
  type OrderModification,
  type OrderPrices,
  type OrderType,
  type OrderRole,
  type OrderStatus,
  type Side,
  type Fill,
  type Position,
  type Trade,
  type OpenTrade,
  type TradingState,
  type CostModel,
  type ExitReason,
} from './orders.js';

export { computeStats, type SessionStats, type StatsInput } from './stats.js';
export {
  sma,
  ema,
  bollinger,
  vwap,
  rsi,
  macd,
  atr,
  donchian,
  stochastic,
  adx,
  orbLevels,
  sourceValue,
  tradingDayKey,
  minutesIntoSession,
  exchangeLocalMinute,
  type IndicatorSource,
  type BollingerResult,
  type VwapPoint,
  type MacdResult,
  type DonchianResult,
  type StochResult,
  type AdxResult,
  type OrbLevels,
  type SessionClock,
} from './indicators.js';
export {
  MACRO_SCHEMA_VERSION,
  parseMacro,
  exampleOrbSmaMacro,
  macroSignal,
  conditionHolds,
  bracketPrices,
  runMacro,
  type Condition,
  type MacroRule,
  type MacroV1,
  type MacroExit,
  type MacroSignal,
  type MacroRunOptions,
  type MacroRunResult,
  type MaKind,
  type MaRef,
  type StopMode,
  type TargetMode,
} from './macro.js';
export {
  tradesToCsv,
  reportHtml,
  escapeHtml,
  TRADE_CSV_COLUMNS,
  type ReportInput,
} from './export.js';

export const CANDLEDRILL_RISK_NOTICE_EN =
  'CandleDrill is an educational practice tool. It is not investment advice. ' +
  'Simulated or practice results do not predict real trading results. ' +
  'Demo data and practice samples are synthetic only: not index-licensed, and not exchange, CME, or Nasdaq data. ' +
  'CandleDrill is not affiliated with any exchange or index provider.';
export const CANDLEDRILL_RISK_NOTICE_ZH_HANT =
  'CandleDrill（K線操練場）只作教育及練習用途，並不構成任何投資建議。模擬或練習成績不能預示真實交易結果。' +
  '示範數據及練習樣本只是合成數據，並非指數授權數據，亦非交易所、CME 或 Nasdaq 數據，與任何交易所或指數供應商無關聯。';

export {
  WEEK_SECONDS,
  BLIND_MIN_WEEKS,
  BLIND_MAX_WEEKS,
  BLIND_SYMBOL,
  disguiseBars,
  revealTime,
  revealPrice,
  blindIssues,
  pickBlindParams,
  pickBlindStartIndex,
  type BlindParams,
  type RandomSource,
} from './blind.js';
export {
  SESSION_FILE_FORMAT,
  SESSION_FILE_VERSION,
  MAX_SESSION_FILE_BYTES,
  MAX_IMPORT_RECORDS,
  parseSessionFile,
  checkSessionState,
  drawingIssues,
  type SessionFile,
} from './import.js';
export {
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_NOTE_LENGTH,
  WEEKDAYS,
  normalizeTags,
  journalEntryIssues,
  journalIssues,
  tradeExcursions,
  groupTrades,
  type Journal,
  type JournalEntry,
  type Excursion,
  type GroupRow,
} from './journal.js';
export {
  RULE_PROFILE_FORMAT,
  RULE_PROFILE_VERSION,
  MAX_PROFILE_NAME,
  MAX_PROFILE_NOTE,
  blankProfile,
  profileIssues,
  parseProfile,
  profileToSettings,
  evaluateProfile,
  type RuleProfile,
  type RuleId,
  type RuleState,
  type RuleResult,
  type ProfileReport,
  type EvalClock,
} from './rules-profile.js';
export {
  equityCurve,
  rDistribution,
  monteCarlo,
  type EquityPoint,
  type RBucket,
  type MonteCarloResult,
} from './review.js';
