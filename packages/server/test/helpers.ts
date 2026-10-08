// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

export const SETTINGS = {
  tickSize: 0.25,
  pointValue: 50,
  commissionPerContract: 2,
  slippageTicks: 1,
  startingBalance: 50_000,
  dailyLossLimit: null,
  trailingDrawdown: null,
  profitTarget: null,
  utcOffsetMinutes: 0,
  dayStartMinutes: 0,
};

/** Fixed API token used by the tests (production generates a random one per launch). */
export const TEST_TOKEN = 'test-token-0123456789abcdef';

/**
 * Make `app.inject` send the API token on every request, as the bundled UI does. Tests of
 * the token/origin guard itself use `rawInject`.
 */
export function withToken(app: FastifyInstance): FastifyInstance {
  const raw = app.inject.bind(app) as (opts: InjectOptions) => Promise<LightMyRequestResponse>;
  const wrapped = (opts: InjectOptions) =>
    raw({ ...opts, headers: { 'x-candledrill-token': TEST_TOKEN, ...(opts.headers ?? {}) } });
  (app as unknown as { rawInject: typeof raw }).rawInject = raw;
  app.inject = wrapped as unknown as FastifyInstance['inject'];
  return app;
}
