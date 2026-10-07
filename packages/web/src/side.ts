// SPDX-License-Identifier: AGPL-3.0-or-later
// Right-hand panel: order ticket, position, working orders and practice-rule meters.

import {
  roundToTick,
  ruleStatus,
  unrealizedPnl,
  workingOrders,
  type OrderRequest,
  type OrderType,
  type Side,
} from '@candledrill/core';
import type { SessionSettings, SessionStateDto } from './api.js';
import { t, type MessageKey } from './i18n.js';
import { el, fmtMoney, fmtNum, signClass } from './format.js';

export interface SideActions {
  place(req: OrderRequest): Promise<void>;
  cancel(orderId: number): Promise<void>;
  flatten(): Promise<void>;
}

export class SidePanel {
  private type: OrderType = 'market';
  private readonly typeButtons = new Map<OrderType, HTMLButtonElement>();
  private readonly qty: HTMLInputElement;
  private readonly price: HTMLInputElement;
  private readonly sl: HTMLInputElement;
  private readonly tp: HTMLInputElement;
  private readonly priceRow: HTMLElement;
  private readonly ordersBox: HTMLElement;
  private readonly positionBox: HTMLElement;
  private readonly rulesBox: HTMLElement;
  readonly extra: HTMLElement;
  private settings: SessionSettings | undefined;
  private state: SessionStateDto | undefined;
  private buyBtn: HTMLButtonElement;
  private sellBtn: HTMLButtonElement;
  private flattenBtn: HTMLButtonElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly actions: SideActions,
  ) {
    const label = (key: MessageKey, input: HTMLElement) =>
      el('label', { class: 'field' }, el('span', { 'data-i18n': key }, t(key)), input);
    const seg = el('div', { class: 'seg', role: 'group', 'aria-label': t('pr.type') });
    for (const [ty, key] of [
      ['market', 'pr.market'],
      ['limit', 'pr.limit'],
      ['stop', 'pr.stop'],
    ] as const) {
      const b = el(
        'button',
        { type: 'button', 'data-i18n': key, 'data-testid': `type-${ty}` },
        t(key),
      );
      b.addEventListener('click', () => this.setType(ty));
      this.typeButtons.set(ty, b);
      seg.append(b);
    }
    this.qty = el('input', {
      type: 'number',
      min: '1',
      max: '10000',
      step: '1',
      value: '1',
      'data-testid': 'qty',
    });
    this.price = el('input', { type: 'number', step: 'any', 'data-testid': 'price' });
    this.sl = el('input', {
      type: 'number',
      min: '1',
      step: '1',
      placeholder: '–',
      'data-testid': 'sl-ticks',
    });
    this.tp = el('input', {
      type: 'number',
      min: '1',
      step: '1',
      placeholder: '–',
      'data-testid': 'tp-ticks',
    });
    this.priceRow = label('pr.price', this.price);
    this.buyBtn = el(
      'button',
      { type: 'button', class: 'buy', 'data-i18n': 'pr.buy', 'data-testid': 'btn-buy' },
      t('pr.buy'),
    );
    this.sellBtn = el(
      'button',
      { type: 'button', class: 'sell', 'data-i18n': 'pr.sell', 'data-testid': 'btn-sell' },
      t('pr.sell'),
    );
    this.flattenBtn = el(
      'button',
      { type: 'button', 'data-i18n': 'pr.flatten', 'data-testid': 'btn-flatten' },
      t('pr.flatten'),
    );
    this.buyBtn.addEventListener('click', () => void this.submit('buy'));
    this.sellBtn.addEventListener('click', () => void this.submit('sell'));
    this.flattenBtn.addEventListener('click', () => void this.actions.flatten());

    const ticket = el(
      'section',
      { class: 'card', 'aria-labelledby': 'h-ticket' },
      el('h3', { id: 'h-ticket', 'data-i18n': 'pr.ticket' }, t('pr.ticket')),
      seg,
      el(
        'div',
        { class: 'grid2', style: 'margin-top:8px' },
        label('pr.qty', this.qty),
        this.priceRow,
      ),
      el(
        'div',
        { class: 'grid2', style: 'margin-top:6px' },
        label('pr.sl', this.sl),
        label('pr.tp', this.tp),
      ),
      el('div', { class: 'grid2', style: 'margin-top:10px' }, this.buyBtn, this.sellBtn),
      el('div', { style: 'margin-top:6px' }, this.flattenBtn),
    );
    this.flattenBtn.style.width = '100%';
    this.positionBox = el('dl', { class: 'kv', 'data-testid': 'position' });
    const position = el(
      'section',
      { class: 'card' },
      el('h3', { 'data-i18n': 'pr.position' }, t('pr.position')),
      this.positionBox,
    );
    this.rulesBox = el('div', { 'data-testid': 'rules' });
    const rules = el(
      'section',
      { class: 'card' },
      el('h3', { 'data-i18n': 'pr.rules' }, t('pr.rules')),
      this.rulesBox,
    );
    this.extra = el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, rules);
    this.ordersBox = el('div', { 'data-testid': 'orders' });
    const orders = el(
      'section',
      { class: 'card' },
      el('h3', { 'data-i18n': 'pr.orders' }, t('pr.orders')),
      this.ordersBox,
    );
    this.root.replaceChildren(ticket, position, this.extra, orders);
    this.setType('market');
  }

  setType(ty: OrderType): void {
    this.type = ty;
    for (const [k, b] of this.typeButtons) b.setAttribute('aria-pressed', String(k === ty));
    this.priceRow.hidden = ty === 'market';
    if (ty !== 'market' && this.state) this.price.value = String(this.state.trading.lastClose);
  }

  /** Set the ticket price (e.g. from a chart click) and switch to limit if on market. */
  setPrice(p: number): void {
    if (!this.settings) return;
    if (this.type === 'market') this.setType('limit');
    this.price.value = String(roundToTick(p, this.settings.tickSize));
  }

  async submit(side: Side): Promise<void> {
    if (!this.settings || !this.state) return;
    const tick = this.settings.tickSize;
    const qty = Number(this.qty.value);
    const price = this.type === 'market' ? null : roundToTick(Number(this.price.value), tick);
    const ref = price ?? this.state.trading.lastClose;
    const dir = side === 'buy' ? 1 : -1;
    const slT = Number(this.sl.value);
    const tpT = Number(this.tp.value);
    await this.actions.place({
      side,
      type: this.type,
      qty,
      price,
      stopLoss: slT > 0 ? roundToTick(ref - dir * slT * tick, tick) : null,
      takeProfit: tpT > 0 ? roundToTick(ref + dir * tpT * tick, tick) : null,
    });
  }

  render(settings: SessionSettings, state: SessionStateDto): void {
    this.settings = settings;
    this.state = state;
    this.price.step = String(settings.tickSize);
    if (this.type !== 'market' && !this.price.value)
      this.price.value = String(state.trading.lastClose);
    const locked = state.status !== 'active';
    this.buyBtn.disabled = locked;
    this.sellBtn.disabled = locked;
    const tr = state.trading;
    const upnl = unrealizedPnl(tr, settings.pointValue);
    const equity = settings.startingBalance + tr.realizedPnl + upnl;
    const pos = tr.position;
    const kv = (k: MessageKey, v: string, cls = '') => [
      el('dt', {}, t(k)),
      el('dd', { class: cls }, v),
    ];
    this.positionBox.replaceChildren(
      ...kv(
        'pr.position',
        pos ? `${t(pos.qty > 0 ? 'pr.long' : 'pr.short')} ${Math.abs(pos.qty)}` : t('pr.flat'),
        pos ? (pos.qty > 0 ? 'up' : 'down') : '',
      ),
      ...kv('pr.avg', pos ? fmtPrice(pos.avgPrice, settings.tickSize) : '–'),
      ...kv('pr.unrealized', fmtMoney(upnl), signClass(upnl)),
      ...kv('pr.realized', fmtMoney(tr.realizedPnl), signClass(tr.realizedPnl)),
      ...kv('pr.equity', fmtMoney(equity)),
    );
    const rs = ruleStatus(settings, state);
    const meter = (key: MessageKey, frac: number | null, limit: number | null) => {
      if (frac === null || limit === null) return [];
      const pct = Math.min(100, Math.max(0, frac * 100));
      const bar = el(
        'div',
        {
          class: 'meter',
          role: 'meter',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': pct.toFixed(0),
          'aria-label': t(key),
        },
        el('span', { style: `width:${pct}%` }),
      );
      const fill = bar.firstElementChild as HTMLElement;
      if (key !== 'pr.target' && frac >= 0.8) fill.style.background = 'var(--down)';
      if (key === 'pr.target') fill.style.background = 'var(--up)';
      return [
        el(
          'div',
          { class: 'row muted', style: 'justify-content:space-between;margin-top:6px' },
          el('span', {}, t(key)),
          el('span', {}, `${pct.toFixed(0)}% · ${fmtMoney(limit)}`),
        ),
        bar,
      ];
    };
    const meters = [
      ...meter('pr.dailyLoss', rs.dailyLossUsed, settings.dailyLossLimit),
      ...meter('pr.trailing', rs.trailingUsed, settings.trailingDrawdown),
      ...meter('pr.target', rs.targetProgress, settings.profitTarget),
    ];
    this.rulesBox.replaceChildren(
      ...(meters.length ? meters : [el('p', { class: 'muted' }, t('pr.noRules'))]),
    );
    const working = workingOrders(state.trading);
    if (working.length === 0) {
      this.ordersBox.replaceChildren(el('p', { class: 'muted' }, t('pr.noOrders')));
    } else {
      const table = el('table', { class: 'data' });
      for (const o of working) {
        const cancel = el(
          'button',
          { type: 'button', class: 'small ghost', 'aria-label': `${t('pr.cancel')} #${o.id}` },
          '✕',
        );
        cancel.addEventListener('click', () => void this.actions.cancel(o.id));
        table.append(
          el(
            'tr',
            {},
            el(
              'td',
              { class: o.side === 'buy' ? 'up' : 'down' },
              `${o.side === 'buy' ? t('pr.buy') : t('pr.sell')} ${o.qty}`,
            ),
            el('td', {}, `${o.type}${o.role !== 'entry' ? ` · ${o.role}` : ''}`),
            el(
              'td',
              { class: 'num' },
              o.price === null ? 'MKT' : fmtNum(o.price, decimals(settings.tickSize)),
            ),
            el('td', { class: 'num' }, cancel),
          ),
        );
      }
      this.ordersBox.replaceChildren(table);
    }
  }
}

/** Price with the tick's decimals, or two more when the value is off-grid (e.g. averages). */
export function fmtPrice(v: number, tick: number): string {
  const d = decimals(tick);
  const onGrid = Math.abs(v / tick - Math.round(v / tick)) < 1e-6;
  return v.toFixed(onGrid ? d : Math.min(10, d + 2));
}

export function decimals(tick: number): number {
  for (let d = 0; d <= 10; d++)
    if (Math.abs(tick * 10 ** d - Math.round(tick * 10 ** d)) < 1e-9) return d;
  return 10;
}
