// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One OHLCV bar. `time` is the bar's OPEN time in Unix seconds (UTC).
 * The bar length is the dataset timeframe (synthetic data is always one minute).
 */
export interface Bar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/**
 * User-defined contract specification. CandleDrill never ships exchange or
 * prop-firm presets; users enter their own values.
 */
export interface InstrumentSpec {
  readonly symbol: string;
  /** Minimum price increment, e.g. 0.25. */
  readonly tickSize: number;
  /** Currency value of a 1.0 price move for one contract, e.g. 50. */
  readonly pointValue: number;
}

/** 0 = Sunday ... 6 = Saturday (same convention as Date#getUTCDay). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * A trading window in exchange-local wall-clock time.
 * `start` is inclusive, `end` is exclusive, both "HH:MM".
 * If `end` <= `start` the window crosses midnight and belongs to the weekday it starts on.
 */
export interface SessionWindow {
  readonly days: readonly Weekday[];
  readonly start: string;
  readonly end: string;
}

/**
 * Session calendar with a FIXED UTC offset. Daylight-saving rules are
 * out of scope for v0.1 (documented limitation).
 */
export interface SessionCalendar {
  readonly utcOffsetMinutes: number;
  readonly windows: readonly SessionWindow[];
  /** Exchange-local dates ("YYYY-MM-DD") with no trading at all. */
  readonly closedDates?: readonly string[];
}

/** Metadata describing where a dataset came from. */
export interface DatasetMeta {
  readonly source: 'synthetic' | 'user-import';
  readonly synthetic: boolean;
  readonly symbol: string;
  readonly timeframeSeconds: number;
  readonly tickSize: number;
  readonly generator?: {
    readonly name: string;
    readonly version: number;
    readonly seed: number;
  };
}
