/**
 * Rendimiento de adquisición y valor: une Marketing (inversión, impresiones, clics),
 * CRM (registros, FTD, bonos), Loyalty y Finanzas (depósitos, GGR, NGR, ROI).
 *
 * Modelo de cohorte: la cohorte de una campaña son los jugadores registrados en el
 * período con esa atribución. Su valor (depósitos, GGR, NGR) se mide desde el registro
 * hasta la fecha de corte. La inversión es la reportada en el mismo período.
 */
import type { EventEnvelope } from '../domain/events.ts';
import { DAY } from '../shared/util.ts';

/** Definición financiera versionada. Validar con Finanzas antes de producción. */
export type FinanceDefinition = {
  version: string;
  /** Impuesto/regalía sobre GGR por mercado (fracción). Valor de ejemplo, configurable. */
  gaming_tax_rate: number;
  /** Base de costo de bonos: valor otorgado y confirmado por el servicio de bonos. */
  bonus_cost_basis: 'granted_confirmed';
  /** Actividad que cuenta para retención. */
  retention_activity: ('bet' | 'deposit')[];
};

export const DEFAULT_FINANCE: FinanceDefinition = {
  version: 'fin-co-2026.11-draft',
  gaming_tax_rate: 0.15,
  bonus_cost_basis: 'granted_confirmed',
  retention_activity: ['bet', 'deposit'],
};

/** Catálogo de definiciones: se muestra en el dashboard y lo usa el copiloto. */
export const METRIC_DEFINITIONS: Record<string, string> = {
  spend: 'Inversión en medios y afiliados reportada en el período (no incluye bonos).',
  ctr: 'Clics / impresiones.',
  registrations: 'Registros del período atribuidos a la campaña.',
  ftd: 'Jugadores de la cohorte con primer depósito liquidado hasta la fecha de corte.',
  ftd_rate: 'FTD % = FTD / registros de la cohorte.',
  cpa: 'CPA = inversión / registros (costo por jugador adquirido).',
  cost_per_ftd: 'Costo por FTD = inversión / FTD.',
  deposits: 'Depósitos liquidados de la cohorte, netos de reversos.',
  ggr: 'GGR = apuestas liquidadas − premios pagados.',
  bonus_cost: 'Costo de bonos otorgados y confirmados a la cohorte.',
  ngr: 'NGR = GGR − costo de bonos − impuesto sobre GGR (tasa de la definición financiera).',
  ngr_per_ftd: 'Valor por FTD = NGR / FTD.',
  retention_d7: 'Retención D7 = % de FTD con actividad (apuesta o depósito) 7 días o más después de su FTD. Solo cuentan FTD con al menos 7 días de antigüedad.',
  retention_d30: 'Retención D30 = igual que D7, con 30 días. Solo cuentan FTD con al menos 30 días de antigüedad.',
  roi: 'ROI = (NGR − inversión) / inversión. El costo de bonos ya está dentro del NGR y no se descuenta dos veces.',
  crm_reach: '% de la cohorte que recibió al menos un mensaje CRM aceptado.',
  loyalty_silver_plus: '% de la cohorte en nivel Plata o superior.',
};

type Spend = { date: string; campaign_id: string; campaign_name: string; channel: string; impressions: number; clicks: number; spend_minor: number; currency: string };
type Activity = { at: number; kind: 'bet' | 'deposit' };
export type PlayerFacts = {
  tenant_id: string;
  player_id: string;
  registered_at: number;
  campaign_id: string;
  channel: string;
  ftd_at?: number;
  currency?: string;
  deposits: Map<string, { at: number; amount: number }>;
  reversed: Map<string, { at: number; amount: number }>;
  bets: { at: number; stake: number; win: number; product?: 'casino' | 'sports' }[];
  bonuses: { at: number; amount: number }[];
  withdrawals: { at: number; amount: number }[];
  device_hash?: string;
  instruments: string[];
  activity: Activity[];
  rg_restricted?: boolean;
};

export type CampaignMetrics = {
  campaign_id: string;
  campaign_name: string;
  channel: string;
  spend_minor: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  registrations: number;
  ftd: number;
  ftd_rate: number | null;
  cpa_minor: number | null;
  cost_per_ftd_minor: number | null;
  deposits_minor: number;
  ggr_minor: number;
  bonus_cost_minor: number;
  gaming_tax_minor: number;
  ngr_minor: number;
  ngr_per_ftd_minor: number | null;
  retention_d7: { rate: number | null; eligible: number; retained: number };
  retention_d30: { rate: number | null; eligible: number; retained: number };
  roi: number | null;
  crm_reach: number | null;
  loyalty_silver_plus: number | null;
};

export type PerformanceReport = {
  tenant_id: string;
  window: { from: string; to: string; days: number };
  currency: string;
  finance_definition: FinanceDefinition;
  totals: CampaignMetrics;
  campaigns: CampaignMetrics[];
  funnel: { impressions: number; clicks: number; registrations: number; ftd: number; retained_d30: number };
  daily: { date: string; spend_minor: number; registrations: number; ftd: number; ngr_minor: number }[];
  data_quality: { spend_days_reported: number; unattributed_registrations: number; mixed_currency_excluded: number };
  definitions: Record<string, string>;
};

export type CohortPayback = {
  campaign_id: string; campaign_name: string; channel: string;
  week_start: string; age_days: number; registrations: number; ftd: number;
  spend_minor: number; ngr_to_date_minor: number; recovered_to_date: number;
  recovered_at: { d7: number | null; d14: number | null; d30: number | null; d60: number | null };
  payback_day: number | null; projected_payback_day: number | null;
};
export type PaybackCurve = { campaign_id: string; campaign_name: string; channel: string; points: { day: number; recovered: number; cohorts: number }[]; payback_day: number | null };
export type PaybackReport = { tenant_id: string; currency: string; as_of: string; weeks: number; max_day: number; finance_definition_version: string; cohorts: CohortPayback[]; curves: PaybackCurve[]; definitions: Record<string, string> };

export type Enrichment = {
  crmReached?: (tenant: string, player: string) => boolean;
  loyaltyLevelRank?: (tenant: string, player: string) => number; // 0 = nivel base
};

const ORGANIC = { campaign_id: 'organic', campaign_name: 'Orgánico / sin atribución', channel: 'organic' };
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Almacén analítico mínimo (en producción: almacén analítico existente de SS1). */
export class PerformanceStore {
  #spend = new Map<string, Map<string, Spend>>(); // tenant → (campaign::date) → spend
  #players = new Map<string, PlayerFacts>();
  #campaignNames = new Map<string, { name: string; channel: string }>();
  #finance = new Map<string, FinanceDefinition>();

  setFinanceDefinition(tenant: string, def: FinanceDefinition) { this.#finance.set(tenant, def); }
  financeDefinition(tenant: string) { return this.#finance.get(tenant) ?? DEFAULT_FINANCE; }

  onEvent(e: EventEnvelope): void {
    const t = Date.parse(e.occurred_at);
    const k = `${e.tenant_id}::${e.player_id}`;
    switch (e.event_type) {
      case 'marketing.spend_reported': {
        const p = (e as EventEnvelope<'marketing.spend_reported'>).payload;
        const m = this.#spend.get(e.tenant_id) ?? new Map<string, Spend>();
        // último reporte del día gana (las plataformas reexpresan cifras)
        m.set(`${p.campaign_id}::${p.date}`, { date: p.date, campaign_id: p.campaign_id, campaign_name: p.campaign_name, channel: p.channel, impressions: p.impressions, clicks: p.clicks, spend_minor: p.spend.amount_minor, currency: p.spend.currency });
        this.#spend.set(e.tenant_id, m);
        this.#campaignNames.set(`${e.tenant_id}::${p.campaign_id}`, { name: p.campaign_name, channel: p.channel });
        return;
      }
      case 'player.registered': {
        const p = (e as EventEnvelope<'player.registered'>).payload;
        if (this.#players.has(k)) return;
        this.#players.set(k, { tenant_id: e.tenant_id, player_id: e.player_id, registered_at: t, campaign_id: p.acquisition?.campaign_id ?? ORGANIC.campaign_id, channel: p.acquisition?.channel ?? ORGANIC.channel, deposits: new Map(), reversed: new Map(), bets: [], bonuses: [], withdrawals: [], instruments: [], activity: [], ...(p.device_hash ? { device_hash: p.device_hash } : {}) });
        if (p.device_hash) this.#link(e.tenant_id, `dev:${p.device_hash}`, e.player_id);
        return;
      }
    }
    const f = this.#players.get(k);
    if (!f) return;
    switch (e.event_type) {
      case 'deposit.settled': {
        const p = (e as EventEnvelope<'deposit.settled'>).payload;
        f.currency ??= p.currency;
        f.deposits.set(p.deposit_id, { at: t, amount: p.amount_minor });
        f.activity.push({ at: t, kind: 'deposit' });
        if (f.ftd_at === undefined || t < f.ftd_at) f.ftd_at = t;
        if (p.instrument_hash && !f.instruments.includes(p.instrument_hash)) { f.instruments.push(p.instrument_hash); this.#link(e.tenant_id, `pay:${p.instrument_hash}`, e.player_id); }
        break;
      }
      case 'deposit.reversed': {
        const p = (e as EventEnvelope<'deposit.reversed'>).payload;
        f.reversed.set(p.deposit_id, { at: t, amount: p.amount_minor });
        break;
      }
      case 'bet.settled': {
        const p = (e as EventEnvelope<'bet.settled'>).payload;
        f.bets.push({ at: t, stake: p.stake.amount_minor, win: p.win?.amount_minor ?? 0, product: p.product });
        f.activity.push({ at: t, kind: 'bet' });
        break;
      }
      case 'reward.granted': {
        const p = (e as EventEnvelope<'reward.granted'>).payload;
        f.bonuses.push({ at: t, amount: p.value.amount_minor });
        break;
      }
      case 'withdrawal.settled': {
        const p = (e as EventEnvelope<'withdrawal.settled'>).payload;
        f.withdrawals.push({ at: t, amount: p.amount_minor });
        break;
      }
      case 'rg.status_changed':
        f.rg_restricted = (e as EventEnvelope<'rg.status_changed'>).payload.status !== 'none';
        break;
    }
  }

  #links = new Map<string, Set<string>>(); // tenant::dev|pay:hash → jugadores
  #link(tenant: string, key: string, player: string) {
    const k = `${tenant}::${key}`;
    const s = this.#links.get(k) ?? new Set<string>();
    s.add(player); this.#links.set(k, s);
  }
  /** Otras cuentas que comparten dispositivo o medio de pago con el jugador. */
  linkedAccounts(tenant: string, player: string): { player_id: string; via: 'device' | 'payment' }[] {
    const f = this.#players.get(`${tenant}::${player}`);
    if (!f) return [];
    const out = new Map<string, 'device' | 'payment'>();
    const add = (key: string, via: 'device' | 'payment') => { for (const o of this.#links.get(`${tenant}::${key}`) ?? []) if (o !== player && !out.has(o)) out.set(o, via); };
    if (f.device_hash) add(`dev:${f.device_hash}`, 'device');
    for (const h of f.instruments) add(`pay:${h}`, 'payment');
    return [...out].map(([player_id, via]) => ({ player_id, via }));
  }
  /** Inversión de una campaña desde una fecha (YYYY-MM-DD), en unidades mínimas. */
  spendSince(tenant: string, campaign: string, fromDate: string): number {
    let s = 0; for (const x of this.#spend.get(tenant)?.values() ?? []) if (x.campaign_id === campaign && x.date >= fromDate) s += x.spend_minor; return s;
  }
  campaignMeta(tenant: string, campaign: string): { name: string; channel: string } {
    return campaign === ORGANIC.campaign_id ? { name: ORGANIC.campaign_name, channel: ORGANIC.channel } : this.#campaignNames.get(`${tenant}::${campaign}`) ?? { name: campaign, channel: 'unknown' };
  }
  fact(tenant: string, player: string): Readonly<PlayerFacts> | undefined { return this.#players.get(`${tenant}::${player}`); }

  /** Hechos por jugador (solo lectura) para los modelos predictivos. */
  playerFacts(tenant: string): readonly Readonly<PlayerFacts>[] {
    return [...this.#players.values()].filter((p) => p.tenant_id === tenant);
  }

  /** Última fecha con inversión reportada por campaña (calidad de datos). */
  lastSpendDates(tenant: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const s of this.#spend.get(tenant)?.values() ?? []) if ((out.get(s.campaign_id) ?? '') < s.date) out.set(s.campaign_id, s.date);
    return out;
  }

  /** % de la cohorte con restricción de juego responsable, por campaña. */
  rgShare(tenant: string, opts: { to: Date; days: number }): Map<string, { restricted: number; total: number }> {
    const to = opts.to.getTime();
    const from = to - opts.days * DAY;
    const out = new Map<string, { restricted: number; total: number }>();
    for (const p of this.#players.values()) {
      if (p.tenant_id !== tenant || p.registered_at < from || p.registered_at > to) continue;
      const m = out.get(p.campaign_id) ?? { restricted: 0, total: 0 };
      m.total++; if (p.rg_restricted) m.restricted++;
      out.set(p.campaign_id, m);
    }
    return out;
  }

  /**
   * Payback por cohorte semanal (campaña × semana de registro).
   * recuperado(t) = NGR acumulado de la cohorte hasta el día t desde el registro / inversión de esa semana.
   * Las curvas por campaña solo usan cohortes con al menos t días de antigüedad (sin sesgo de cohortes jóvenes).
   */
  payback(tenant: string, opts: { to: Date; weeks: number; maxDay?: number; currency?: string }): PaybackReport {
    const fin = this.financeDefinition(tenant);
    const to = opts.to.getTime();
    const maxDay = opts.maxDay ?? 90;
    const currency = opts.currency ?? 'COP';
    const weekStart = (t: number) => { const d = new Date(t); const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY; };
    const firstWeek = weekStart(to) - (opts.weeks - 1) * 7 * DAY;
    type Acc = { campaign_id: string; week: number; spend: number; players: PlayerFacts[] };
    const cohorts = new Map<string, Acc>();
    const acc = (c: string, w: number) => { const k = `${c}::${w}`; let a = cohorts.get(k); if (!a) { a = { campaign_id: c, week: w, spend: 0, players: [] }; cohorts.set(k, a); } return a; };
    for (const s of this.#spend.get(tenant)?.values() ?? []) {
      if (s.currency !== currency) continue;
      const w = weekStart(Date.parse(s.date + 'T12:00:00Z'));
      if (w >= firstWeek && w <= to) acc(s.campaign_id, w).spend += s.spend_minor;
    }
    for (const p of this.#players.values()) {
      if (p.tenant_id !== tenant || p.campaign_id === ORGANIC.campaign_id || (p.currency && p.currency !== currency)) continue;
      const w = weekStart(p.registered_at);
      if (w >= firstWeek && p.registered_at <= to) acc(p.campaign_id, w).players.push(p);
    }
    const curveOf = (players: PlayerFacts[], ageDays: number) => {
      const n = Math.min(maxDay, ageDays);
      const ggr = new Array(n + 1).fill(0), bonus = new Array(n + 1).fill(0);
      for (const p of players) {
        for (const b of p.bets) { const d = Math.floor((b.at - p.registered_at) / DAY); if (d >= 0 && d <= n && b.at <= to) ggr[d] += b.stake - b.win; }
        for (const b of p.bonuses) { const d = Math.floor((b.at - p.registered_at) / DAY); if (d >= 0 && d <= n && b.at <= to) bonus[d] += b.amount; }
      }
      const out: number[] = [];
      let cg = 0, cb = 0;
      for (let d = 0; d <= n; d++) { cg += ggr[d]; cb += bonus[d]; out.push(cg - cb - Math.round(Math.max(0, cg) * fin.gaming_tax_rate)); }
      return out; // NGR acumulado por día relativo
    };
    const rows: CohortPayback[] = [];
    const byCampaign = new Map<string, { age: number; spend: number; ngr: number[] }[]>();
    for (const a of cohorts.values()) {
      if (a.spend <= 0) continue;
      const age = Math.floor((to - (a.week + 6 * DAY)) / DAY); // días desde el final de la semana
      const ngr = curveOf(a.players, Math.max(0, Math.floor((to - a.week) / DAY)));
      const at = (d: number) => (age >= d ? ngr[Math.min(d, ngr.length - 1)] / a.spend : null);
      const toDate = ngr.at(-1) ?? 0;
      const paidDay = ngr.findIndex((v) => v >= a.spend);
      let projected: number | null = null;
      if (paidDay < 0 && ngr.length > 14) {
        const slope = (ngr.at(-1)! - ngr[ngr.length - 15]) / 14;
        projected = slope > 0 ? Math.ceil(ngr.length - 1 + (a.spend - ngr.at(-1)!) / slope) : null;
      }
      const meta = this.#campaignNames.get(`${tenant}::${a.campaign_id}`);
      rows.push({
        campaign_id: a.campaign_id, campaign_name: meta?.name ?? a.campaign_id, channel: meta?.channel ?? 'unknown',
        week_start: new Date(a.week).toISOString().slice(0, 10), age_days: Math.max(0, age),
        registrations: a.players.length, ftd: a.players.filter((p) => p.ftd_at !== undefined && p.ftd_at <= to).length,
        spend_minor: a.spend, ngr_to_date_minor: toDate, recovered_to_date: toDate / a.spend,
        recovered_at: { d7: at(7), d14: at(14), d30: at(30), d60: at(60) },
        payback_day: paidDay >= 0 ? paidDay : null,
        projected_payback_day: projected !== null && projected <= 365 ? projected : null,
      });
      byCampaign.set(a.campaign_id, [...(byCampaign.get(a.campaign_id) ?? []), { age: Math.max(0, age), spend: a.spend, ngr }]);
    }
    rows.sort((x, y) => y.week_start.localeCompare(x.week_start) || x.campaign_name.localeCompare(y.campaign_name));
    const curves: PaybackCurve[] = [...byCampaign].map(([id, cs]) => {
      const points: { day: number; recovered: number; cohorts: number }[] = [];
      for (let d = 0; d <= maxDay; d++) {
        const mature = cs.filter((c) => c.age >= d && c.ngr.length > d);
        // con menos de 2 cohortes la curva solo refleja el cambio de composición
        if (mature.length < Math.min(2, cs.length)) break;
        const spend = mature.reduce((s, c) => s + c.spend, 0);
        points.push({ day: d, recovered: mature.reduce((s, c) => s + c.ngr[d], 0) / spend, cohorts: mature.length });
      }
      const meta = this.#campaignNames.get(`${tenant}::${id}`);
      const pd = points.find((p) => p.recovered >= 1)?.day ?? null;
      return { campaign_id: id, campaign_name: meta?.name ?? id, channel: meta?.channel ?? 'unknown', points, payback_day: pd };
    }).sort((a, b) => a.campaign_id.localeCompare(b.campaign_id));
    return { tenant_id: tenant, currency, as_of: new Date(to).toISOString(), weeks: opts.weeks, max_day: maxDay, finance_definition_version: fin.version, cohorts: rows, curves,
      definitions: {
        recovered: 'Recuperado = NGR acumulado de la cohorte desde el registro / inversión de la campaña en la semana de la cohorte.',
        payback_day: 'Día de payback = primer día desde el registro en que el NGR acumulado iguala o supera la inversión.',
        projected_payback_day: 'Proyección lineal con el ritmo de NGR de los últimos 14 días. Indicativa, no un pronóstico.',
        curve: 'Las curvas por campaña solo incluyen cohortes con al menos t días de antigüedad en cada punto t.',
      } };
  }

  report(tenant: string, opts: { to: Date; days: number; currency?: string }, enrich: Enrichment = {}): PerformanceReport {
    const fin = this.financeDefinition(tenant);
    const to = opts.to.getTime();
    const from = to - opts.days * DAY;
    const currency = opts.currency ?? 'COP';
    const fromDay = isoDay(from);
    const toDay = isoDay(to);

    const spendRows = [...(this.#spend.get(tenant)?.values() ?? [])].filter((s) => s.date >= fromDay && s.date <= toDay && s.currency === currency);
    let mixed = [...(this.#spend.get(tenant)?.values() ?? [])].filter((s) => s.date >= fromDay && s.date <= toDay && s.currency !== currency).length;
    const cohort = [...this.#players.values()].filter((p) => p.tenant_id === tenant && p.registered_at >= from && p.registered_at <= to);
    const inCurrency = cohort.filter((p) => !p.currency || p.currency === currency);
    mixed += cohort.length - inCurrency.length;

    const ids = new Set<string>([...spendRows.map((s) => s.campaign_id), ...inCurrency.map((p) => p.campaign_id)]);
    const compute = (campaign_id: string | null, spends: Spend[], players: PlayerFacts[]): CampaignMetrics => {
      const meta = campaign_id === null ? { name: 'Total', channel: 'all' } : campaign_id === ORGANIC.campaign_id ? { name: ORGANIC.campaign_name, channel: ORGANIC.channel } : this.#campaignNames.get(`${tenant}::${campaign_id}`) ?? { name: campaign_id, channel: players[0]?.channel ?? 'unknown' };
      const spend = spends.reduce((s, x) => s + x.spend_minor, 0);
      const impressions = spends.reduce((s, x) => s + x.impressions, 0);
      const clicks = spends.reduce((s, x) => s + x.clicks, 0);
      let ftd = 0, deposits = 0, ggr = 0, bonus = 0;
      const ret = { d7: { eligible: 0, retained: 0 }, d30: { eligible: 0, retained: 0 } };
      let reached = 0, silver = 0;
      for (const p of players) {
        if (p.ftd_at !== undefined && p.ftd_at <= to) {
          ftd++;
          for (const [n, key] of [[7, 'd7'], [30, 'd30']] as const) {
            if (p.ftd_at + n * DAY <= to) {
              ret[key].eligible++;
              if (p.activity.some((a) => fin.retention_activity.includes(a.kind) && a.at >= p.ftd_at! + n * DAY && a.at <= to)) ret[key].retained++;
            }
          }
        }
        for (const [id, d] of p.deposits) if (d.at <= to) deposits += d.amount - ((p.reversed.get(id)?.at ?? Infinity) <= to ? p.reversed.get(id)!.amount : 0);
        for (const b of p.bets) if (b.at <= to) ggr += b.stake - b.win;
        for (const b of p.bonuses) if (b.at <= to) bonus += b.amount;
        if (enrich.crmReached?.(tenant, p.player_id)) reached++;
        if ((enrich.loyaltyLevelRank?.(tenant, p.player_id) ?? 0) >= 1) silver++;
      }
      const tax = Math.round(Math.max(0, ggr) * fin.gaming_tax_rate);
      const ngr = ggr - bonus - tax;
      return {
        campaign_id: campaign_id ?? 'total', campaign_name: meta.name, channel: meta.channel,
        spend_minor: spend, impressions, clicks, ctr: ratio(clicks, impressions),
        registrations: players.length, ftd, ftd_rate: ratio(ftd, players.length),
        cpa_minor: players.length && spend ? Math.round(spend / players.length) : null,
        cost_per_ftd_minor: ftd && spend ? Math.round(spend / ftd) : null,
        deposits_minor: deposits, ggr_minor: ggr, bonus_cost_minor: bonus, gaming_tax_minor: tax, ngr_minor: ngr,
        ngr_per_ftd_minor: ftd ? Math.round(ngr / ftd) : null,
        retention_d7: { ...ret.d7, rate: ratio(ret.d7.retained, ret.d7.eligible) },
        retention_d30: { ...ret.d30, rate: ratio(ret.d30.retained, ret.d30.eligible) },
        roi: spend > 0 ? (ngr - spend) / spend : null,
        crm_reach: enrich.crmReached && players.length ? reached / players.length : null,
        loyalty_silver_plus: enrich.loyaltyLevelRank && players.length ? silver / players.length : null,
      };
    };

    const campaigns = [...ids].map((id) => compute(id, spendRows.filter((s) => s.campaign_id === id), inCurrency.filter((p) => p.campaign_id === id)))
      .sort((a, b) => (a.campaign_id === ORGANIC.campaign_id ? 1 : b.campaign_id === ORGANIC.campaign_id ? -1 : b.spend_minor - a.spend_minor));
    const totals = compute(null, spendRows, inCurrency);

    const days: PerformanceReport['daily'] = [];
    for (let d = from; d <= to; d += DAY) {
      const day = isoDay(d);
      const regs = inCurrency.filter((p) => isoDay(p.registered_at) === day);
      days.push({
        date: day,
        spend_minor: spendRows.filter((s) => s.date === day).reduce((s, x) => s + x.spend_minor, 0),
        registrations: regs.length,
        ftd: inCurrency.filter((p) => p.ftd_at !== undefined && isoDay(p.ftd_at) === day).length,
        ngr_minor: 0,
      });
    }
    // NGR diario de la cohorte (apuestas − premios − bonos − impuesto), por fecha de actividad
    const byDay = new Map(days.map((x) => [x.date, x]));
    for (const p of inCurrency) {
      for (const b of p.bets) { const row = byDay.get(isoDay(b.at)); if (row) row.ngr_minor += Math.round((b.stake - b.win) * (1 - fin.gaming_tax_rate)); }
      for (const b of p.bonuses) { const row = byDay.get(isoDay(b.at)); if (row) row.ngr_minor -= b.amount; }
    }

    return {
      tenant_id: tenant,
      window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days: opts.days },
      currency,
      finance_definition: fin,
      totals,
      campaigns,
      funnel: { impressions: totals.impressions, clicks: totals.clicks, registrations: totals.registrations, ftd: totals.ftd, retained_d30: totals.retention_d30.retained },
      daily: days,
      data_quality: { spend_days_reported: new Set(spendRows.map((s) => s.date)).size, unattributed_registrations: inCurrency.filter((p) => p.campaign_id === ORGANIC.campaign_id).length, mixed_currency_excluded: mixed },
      definitions: METRIC_DEFINITIONS,
    };
  }
}
