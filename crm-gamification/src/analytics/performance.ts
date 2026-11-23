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
type PlayerFacts = {
  tenant_id: string;
  player_id: string;
  registered_at: number;
  campaign_id: string;
  channel: string;
  ftd_at?: number;
  currency?: string;
  deposits: Map<string, { at: number; amount: number }>;
  reversed: Map<string, { at: number; amount: number }>;
  bets: { at: number; stake: number; win: number }[];
  bonuses: { at: number; amount: number }[];
  activity: Activity[];
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
        this.#players.set(k, { tenant_id: e.tenant_id, player_id: e.player_id, registered_at: t, campaign_id: p.acquisition?.campaign_id ?? ORGANIC.campaign_id, channel: p.acquisition?.channel ?? ORGANIC.channel, deposits: new Map(), reversed: new Map(), bets: [], bonuses: [], activity: [] });
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
        break;
      }
      case 'deposit.reversed': {
        const p = (e as EventEnvelope<'deposit.reversed'>).payload;
        f.reversed.set(p.deposit_id, { at: t, amount: p.amount_minor });
        break;
      }
      case 'bet.settled': {
        const p = (e as EventEnvelope<'bet.settled'>).payload;
        f.bets.push({ at: t, stake: p.stake.amount_minor, win: p.win?.amount_minor ?? 0 });
        f.activity.push({ at: t, kind: 'bet' });
        break;
      }
      case 'reward.granted': {
        const p = (e as EventEnvelope<'reward.granted'>).payload;
        f.bonuses.push({ at: t, amount: p.value.amount_minor });
        break;
      }
    }
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
