// SPDX-License-Identifier: AGPL-3.0-or-later
// Right-hand panel: order ticket, position, working orders and practice-rule meters.

import {
  disciplineStatus,
  roundToTick,
  ruleStatus,
  sessionEquity,
  tickDecimals,
  unrealizedPnl,
  workingOrders,
  type Order,
  type OrderChange,
  type OrderRequest,
  type OrderType,
  type Side,
} from '@candledrill/core';
import type { SessionSettings, SessionStateDto } from './api.js';
import { t, type MessageKey } from './i18n.js';
import { orderRoleText, orderTypeText } from './labels.js';
import { el, fmtMoney, fmtNum, signClass } from './format.js';

export interface SideActions {
  place(req: OrderRequest): Promise<void>;
  cancel(orderId: number): Promise<void>;
  modify(orderId: number, change: OrderChange): Promise<void>;
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
  private readonly riskPreview: HTMLElement;
  private readonly ordersBox: HTMLElement;
  private readonly positionBox: HTMLElement;
  private readonly rulesBox: HTMLElement;
  readonly extra: HTMLElement;
  private settings: SessionSettings | undefined;
  private state: SessionStateDto | undefined;
  private buyBtn: HTMLButtonElement;
  private sellBtn: HTMLButtonElement;
  private flattenBtn: HTMLButtonElement;
  private readonly dialog: HTMLDialogElement;
  private readonly dialogOrderId: HTMLElement;
  private readonly dialogPrice: HTMLInputElement;
  private readonly dialogPriceRow: HTMLElement;
  private readonly dialogSl: HTMLInputElement;
  private readonly dialogSlRow: HTMLElement;
  private readonly dialogTp: HTMLInputElement;
  private readonly dialogTpRow: HTMLElement;
  private dialogCurrentOrderId: number | null = null;

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
    this.riskPreview = el('p', { class: 'muted small', 'data-testid': 'risk-preview' }, '');
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
    for (const input of [this.qty, this.sl, this.tp])
      input.addEventListener('input', () => this.updateRiskPreview());

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
      el('p', { class: 'muted small', 'data-i18n': 'pr.bracketHint' }, t('pr.bracketHint')),
      this.riskPreview,
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
      el('p', { class: 'muted small', 'data-i18n': 'pr.realizedHint' }, t('pr.realizedHint')),
    );
    this.rulesBox = el('div', { 'data-testid': 'rules' });
    const rules = el(
      'section',
      { class: 'card' },
      el('h3', { 'data-i18n': 'pr.rules' }, t('pr.rules')),
      el('p', { class: 'muted small', 'data-i18n': 'pr.rulesBar' }, t('pr.rulesBar')),
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

    this.dialogOrderId = el('span', {});
    this.dialogPrice = el('input', { type: 'number', step: 'any', 'data-testid': 'modify-price' });
    this.dialogPriceRow = label('pr.price', this.dialogPrice);
    this.dialogSl = el('input', { type: 'number', step: 'any', 'data-testid': 'modify-sl' });
    this.dialogSlRow = label('pr.slPrice', this.dialogSl);
    this.dialogTp = el('input', { type: 'number', step: 'any', 'data-testid': 'modify-tp' });
    this.dialogTpRow = label('pr.tpPrice', this.dialogTp);
    const dialogSubmit = el(
      'button',
      { type: 'button', class: 'primary', 'data-testid': 'modify-submit' },
      t('pr.modify'),
    );
    const dialogCancel = el(
      'button',
      { type: 'button', 'data-testid': 'modify-cancel' },
      t('pr.cancel'),
    );
    dialogSubmit.addEventListener('click', () => void this.submitModify());
    dialogCancel.addEventListener('click', () => this.dialog.close());
    this.dialog = el(
      'dialog',
      { 'data-testid': 'modify-dialog' },
      el('h2', {}, t('pr.modifyTitle'), ' #', this.dialogOrderId),
      el('div', { class: 'grid2', style: 'margin-top:12px' }, this.dialogPriceRow, el('span', {})),
      el('div', { class: 'grid2', style: 'margin-top:8px' }, this.dialogSlRow, this.dialogTpRow),
      el(
        'div',
        { class: 'row', style: 'justify-content:flex-end;margin-top:16px' },
        dialogCancel,
        dialogSubmit,
      ),
    ) as HTMLDialogElement;
    this.dialog.addEventListener('close', () => {
      this.dialogCurrentOrderId = null;
    });

    this.root.replaceChildren(ticket, position, this.extra, orders);
    document.body.append(this.dialog);
    this.setType('market');
  }

  setType(ty: OrderType): void {
    this.type = ty;
    for (const [k, b] of this.typeButtons) b.setAttribute('aria-pressed', String(k === ty));
    this.priceRow.hidden = ty === 'market';
    if (ty !== 'market' && this.state) this.price.value = String(this.state.trading.lastClose);
    this.updateRiskPreview();
  }

  /** Set the ticket price (e.g. from a chart click) and switch to limit if on market. */
  setPrice(p: number): void {
    if (!this.settings) return;
    if (this.type === 'market') this.setType('limit');
    this.price.value = String(roundToTick(p, this.settings.tickSize));
  }

  private updateRiskPreview(): void {
    if (!this.settings) return;
    const qty = Number(this.qty.value);
    const slTicks = Number(this.sl.value);
    if (!Number.isFinite(qty) || !Number.isFinite(slTicks) || qty <= 0 || slTicks <= 0) {
      this.riskPreview.textContent = `${t('pr.riskPreview')}: ${t('pr.riskNa')}`;
      return;
    }
    const risk = qty * slTicks * this.settings.tickSize * this.settings.pointValue;
    this.riskPreview.textContent = `${t('pr.riskPreview')}: ${fmtMoney(risk)} (${slTicks} ${t('unit.tick')})`;
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

  private openModifyDialog(o: Order): void {
    if (!this.settings) return;
    this.dialogCurrentOrderId = o.id;
    this.dialogOrderId.textContent = String(o.id);
    const tick = this.settings.tickSize;
    this.dialogPrice.step = String(tick);
    this.dialogSl.step = String(tick);
    this.dialogTp.step = String(tick);
    if (o.role === 'entry') {
      this.dialogPriceRow.hidden = o.type === 'market';
      this.dialogPrice.value = o.price === null ? '' : String(o.price);
      this.dialogSlRow.hidden = false;
      this.dialogTpRow.hidden = false;
      this.dialogSl.value = o.stopLoss === null ? '' : String(o.stopLoss);
      this.dialogTp.value = o.takeProfit === null ? '' : String(o.takeProfit);
    } else {
      this.dialogPriceRow.hidden = false;
      this.dialogPrice.value = o.price === null ? '' : String(o.price);
      this.dialogSlRow.hidden = true;
      this.dialogTpRow.hidden = true;
      this.dialogSl.value = '';
      this.dialogTp.value = '';
    }
    this.dialog.showModal();
  }

  private async submitModify(): Promise<void> {
    if (this.dialogCurrentOrderId === null || !this.settings) return;
    const tick = this.settings.tickSize;
    const price = this.dialogPriceRow.hidden
      ? undefined
      : roundToTick(Number(this.dialogPrice.value), tick);
    const sl = this.dialogSlRow.hidden
      ? undefined
      : this.dialogSl.value === ''
        ? null
        : roundToTick(Number(this.dialogSl.value), tick);
    const tp = this.dialogTpRow.hidden
      ? undefined
      : this.dialogTp.value === ''
        ? null
        : roundToTick(Number(this.dialogTp.value), tick);
    const change: OrderChange =
      price === undefined
        ? {
            ...(sl === undefined ? {} : { stopLoss: sl }),
            ...(tp === undefined ? {} : { takeProfit: tp }),
          }
        : {
            price,
            ...(sl === undefined ? {} : { stopLoss: sl }),
            ...(tp === undefined ? {} : { takeProfit: tp }),
          };
    if (Object.keys(change).length === 0) return;
    try {
      await this.actions.modify(this.dialogCurrentOrderId, change);
      this.dialog.close();
    } catch {
      // The caller shows the error; keep the dialog open so the user can correct it.
    }
  }

  render(settings: SessionSettings, state: SessionStateDto): void {
    this.settings = settings;
    this.state = state;
    this.price.step = String(settings.tickSize);
    if (this.type !== 'market' && !this.price.value)
      this.price.value = String(state.trading.lastClose);
    this.updateRiskPreview();
    const locked = state.status !== 'active';
    this.buyBtn.disabled = locked;
    this.sellBtn.disabled = locked;
    // At the end of the data no later bar exists to fill a flatten order (keep-open policy).
    this.flattenBtn.disabled = state.status === 'finished';
    const tr = state.trading;
    const upnl = unrealizedPnl(tr, settings.pointValue);
    const equity = sessionEquity(settings, state);
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
    if (settings.maxDailyTradeCycles || settings.maxConsecutiveLosses) {
      const discipline = disciplineStatus(settings, state);
      meters.push(
        el(
          'p',
          { class: 'muted', 'data-testid': 'discipline-counts' },
          t('pr.disciplineCounts', {
            cycles: discipline.cycles,
            streak: discipline.losingStreak,
            maxCycles: settings.maxDailyTradeCycles ?? t('pr.disciplineOff'),
            maxLosses: settings.maxConsecutiveLosses ?? t('pr.disciplineOff'),
          }),
        ),
      );
      if (discipline.reason)
        meters.push(
          el(
            'p',
            { role: 'status', 'data-testid': 'discipline-paused' },
            t(
              discipline.reason === 'daily-trade-cycle limit'
                ? 'pr.disciplineCyclesPaused'
                : 'pr.disciplineLossPaused',
            ),
          ),
        );
    }
    const drawdown: Node[] = [];
    if (settings.trailingDrawdown !== null) {
      const peak = state.equityPeak;
      const floor = peak - settings.trailingDrawdown;
      const currentDd = Math.max(0, peak - equity);
      const buffer = equity - floor;
      drawdown.push(
        el(
          'dl',
          { class: 'kv', style: 'margin-top:8px' },
          ...kv('pr.ddPeak', fmtMoney(peak)),
          ...kv('pr.ddFloor', fmtMoney(floor)),
          ...kv('pr.ddCurrent', fmtMoney(currentDd), currentDd > 0 ? 'down' : ''),
          ...kv('pr.ddBuffer', fmtMoney(buffer), buffer < 0 ? 'down' : ''),
        ),
        el('p', { class: 'muted small', 'data-i18n': 'pr.drawdownNote' }, t('pr.drawdownNote')),
      );
    }
    this.rulesBox.replaceChildren(
      ...(meters.length ? meters : [el('p', { class: 'muted' }, t('pr.noRules'))]),
      ...drawdown,
    );
    const working = workingOrders(state.trading);
    if (working.length === 0) {
      this.ordersBox.replaceChildren(el('p', { class: 'muted' }, t('pr.noOrders')));
    } else {
      const table = el('table', { class: 'data' });
      for (const o of working) {
        const edit = el(
          'button',
          {
            type: 'button',
            class: 'small ghost',
            'aria-label': `${t('pr.modify')} #${o.id}`,
            'data-testid': `modify-${o.id}`,
          },
          '✎',
        );
        edit.addEventListener('click', () => this.openModifyDialog(o));
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
            el(
              'td',
              {},
              `${orderTypeText(o.type)}${o.role !== 'entry' ? ` · ${orderRoleText(o.role)}` : ''}`,
            ),
            el(
              'td',
              { class: 'num' },
              o.price === null ? 'MKT' : fmtNum(o.price, decimals(settings.tickSize)),
            ),
            el('td', { class: 'num' }, edit, cancel),
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

/** Same count as `tickDecimals` in core (the price axis uses that function). */
export function decimals(tick: number): number {
  return tickDecimals(tick);
}
