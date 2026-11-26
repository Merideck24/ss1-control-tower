/**
 * Alertas de KPI para el Control Tower. Reglas deterministas y explicables sobre las
 * métricas de rendimiento: cada alerta trae valor actual, referencia, umbral, ventana
 * y una acción sugerida. Exigen muestra mínima para no alertar sobre ruido.
 */
import type { CampaignMetrics, PerformanceStore } from './performance.ts';
import { DAY } from '../shared/util.ts';

export type Severity = 'warning' | 'serious' | 'critical';
export type KpiAlert = {
  id: string;
  rule: string;
  severity: Severity;
  campaign_id?: string;
  campaign_name?: string;
  title: string;
  detail: string;
  current: number | string | null;
  baseline?: number | string | null;
  threshold: number | string;
  unit: 'ratio' | 'money' | 'days' | 'count';
  window: string;
  action: string;
  acknowledged?: { by: string; at: string; note?: string };
};

/** Umbrales por tenant. Valores iniciales de ejemplo, a calibrar con Marketing y Finanzas. */
export type KpiAlertConfig = {
  ctr_drop_pct: number;
  ftd_rate_drop_pct: number;
  cpa_rise_pct: number;
  cost_per_ftd_target_minor: number;
  payback_target_days: number;
  rg_share_max: number;
  min_rg_cases: number;
  budget_warn: number;
  budget_serious: number;
  min_clicks: number;
  min_registrations: number;
  spend_missing_days: number;
};

export const DEFAULT_ALERT_CONFIG: KpiAlertConfig = {
  ctr_drop_pct: 25,
  ftd_rate_drop_pct: 25,
  cpa_rise_pct: 30,
  cost_per_ftd_target_minor: 250_000_00,
  payback_target_days: 60,
  rg_share_max: 0.08,
  min_rg_cases: 5,
  budget_warn: 0.8,
  budget_serious: 0.95,
  min_clicks: 300,
  min_registrations: 15,
  spend_missing_days: 2,
};

export type AlertInputs = {
  store: PerformanceStore;
  tenant: string;
  now: Date;
  config: KpiAlertConfig;
  budgets: { reward_id: string; name?: string; budget_minor: number; committed_minor: number }[];
  /** zona horaria del operador para contar días de calendario (por defecto Colombia) */
  timezone?: string;
};

/** Fecha de calendario (YYYY-MM-DD) en una zona horaria. */
export const localDay = (d: Date, timeZone = 'America/Bogota') => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const shortDate = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const pctChange = (cur: number, base: number) => (cur - base) / base;
/** z de la diferencia de dos proporciones (aprox. normal, varianza combinada). */
export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): number {
  if (n1 <= 0 || n2 <= 0) return 0;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? (x1 / n1 - x2 / n2) / se : 0;
}
const Z_95 = 1.96;
const fmtPct = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')} %`;
const fmtMoney = (minor: number) => (minor / 100).toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

export function evaluateKpiAlerts(i: AlertInputs): KpiAlert[] {
  const { store, tenant, now, config: c } = i;
  const day = now.toISOString().slice(0, 10);
  const out: KpiAlert[] = [];
  const push = (a: Omit<KpiAlert, 'id'>) => out.push({ id: `${a.rule}:${a.campaign_id ?? 'all'}:${day}`, ...a });

  // Ventanas: actual = últimos 7 días; referencia = los 28 días anteriores.
  // FTD % usa ventanas desplazadas 2 días para no medir cohortes que aún no han depositado.
  const cur = store.report(tenant, { to: now, days: 7 });
  const base = store.report(tenant, { to: new Date(now.getTime() - 7 * DAY), days: 28 });
  const curF = store.report(tenant, { to: new Date(now.getTime() - 2 * DAY), days: 7 });
  const baseF = store.report(tenant, { to: new Date(now.getTime() - 9 * DAY), days: 28 });
  const find = (r: typeof cur, id: string) => r.campaigns.find((x) => x.campaign_id === id);
  const paid = (m?: CampaignMetrics) => !!m && m.campaign_id !== 'organic';

  for (const m of cur.campaigns.filter(paid)) {
    const b = find(base, m.campaign_id);
    if (b && m.ctr !== null && b.ctr !== null && m.clicks >= c.min_clicks / 4 && b.clicks >= c.min_clicks) {
      const ch = pctChange(m.ctr, b.ctr);
      const z = twoProportionZ(m.clicks, m.impressions, b.clicks, b.impressions);
      if (ch <= -c.ctr_drop_pct / 100 && z <= -Z_95) push({ rule: 'ctr_drop', severity: ch <= -2 * c.ctr_drop_pct / 100 ? 'serious' : 'warning', campaign_id: m.campaign_id, campaign_name: m.campaign_name, title: `CTR en caída: ${m.campaign_name}`, detail: `CTR ${fmtPct(m.ctr)} en 7 días frente a ${fmtPct(b.ctr)} en los 28 anteriores (${fmtPct(ch)}).`, current: m.ctr, baseline: b.ctr, threshold: -c.ctr_drop_pct / 100, unit: 'ratio', window: '7 d vs 28 d previos', action: 'Revisar fatiga de creatividades y frecuencia en la plataforma; rotar piezas o ajustar audiencia.' });
    }
    if (b && m.cpa_minor !== null && b.cpa_minor !== null && m.registrations >= c.min_registrations / 2 && b.registrations >= c.min_registrations) {
      const ch = pctChange(m.cpa_minor, b.cpa_minor);
      if (ch >= c.cpa_rise_pct / 100) push({ rule: 'cpa_rise', severity: ch >= 2 * c.cpa_rise_pct / 100 ? 'serious' : 'warning', campaign_id: m.campaign_id, campaign_name: m.campaign_name, title: `CPA al alza: ${m.campaign_name}`, detail: `CPA ${fmtMoney(m.cpa_minor)} en 7 días frente a ${fmtMoney(b.cpa_minor)} (+${fmtPct(ch)}).`, current: m.cpa_minor, baseline: b.cpa_minor, threshold: c.cpa_rise_pct / 100, unit: 'money', window: '7 d vs 28 d previos', action: 'Revisar pujas y conversión de la landing; mover presupuesto a campañas con mejor costo por FTD.' });
    }
  }
  for (const m of curF.campaigns.filter(paid)) {
    const b = find(baseF, m.campaign_id);
    if (b && m.ftd_rate !== null && b.ftd_rate !== null && m.registrations >= c.min_registrations && b.registrations >= c.min_registrations) {
      const ch = pctChange(m.ftd_rate, b.ftd_rate);
      const z = twoProportionZ(m.ftd, m.registrations, b.ftd, b.registrations);
      if (ch <= -c.ftd_rate_drop_pct / 100 && z <= -Z_95) push({ rule: 'ftd_rate_drop', severity: 'serious', campaign_id: m.campaign_id, campaign_name: m.campaign_name, title: `FTD % en caída: ${m.campaign_name}`, detail: `FTD % ${fmtPct(m.ftd_rate)} frente a ${fmtPct(b.ftd_rate)} (${fmtPct(ch)}). Ventanas desplazadas 2 días para dejar madurar el primer depósito.`, current: m.ftd_rate, baseline: b.ftd_rate, threshold: -c.ftd_rate_drop_pct / 100, unit: 'ratio', window: '7 d vs 28 d previos (corte −2 d)', action: 'Revisar el flujo de registro → verificación → primer depósito (KYC, métodos de pago, recorrido de bienvenida).' });
    }
  }
  // Costo por FTD sobre objetivo (30 días, cohortes con FTD maduro)
  const month = store.report(tenant, { to: new Date(now.getTime() - 2 * DAY), days: 30 });
  for (const m of month.campaigns.filter(paid)) {
    if (m.cost_per_ftd_minor !== null && m.registrations >= c.min_registrations && m.cost_per_ftd_minor > c.cost_per_ftd_target_minor) {
      const over = m.cost_per_ftd_minor / c.cost_per_ftd_target_minor - 1;
      push({ rule: 'cost_per_ftd_above_target', severity: over >= 0.5 ? 'serious' : 'warning', campaign_id: m.campaign_id, campaign_name: m.campaign_name, title: `Costo por FTD sobre objetivo: ${m.campaign_name}`, detail: `${fmtMoney(m.cost_per_ftd_minor)} por FTD en los últimos 30 días (sin contar los 2 más recientes, cuyos FTD aún maduran); objetivo ${fmtMoney(c.cost_per_ftd_target_minor)} (+${fmtPct(over)}).`, current: m.cost_per_ftd_minor, threshold: c.cost_per_ftd_target_minor, unit: 'money', window: '30 d (corte −2 d)', action: 'Reducir inversión o renegociar; la campaña trae registros que no depositan.' });
    }
  }
  // Payback por cohorte, agrupado por campaña para no repetir una alerta por semana
  const pb = store.payback(tenant, { to: now, weeks: 13 });
  const byCampaign = new Map<string, { name: string; overdue: typeof pb.cohorts; atRisk: typeof pb.cohorts }>();
  for (const cohort of pb.cohorts) {
    if (cohort.payback_day !== null || cohort.registrations < c.min_registrations / 3) continue;
    const g = byCampaign.get(cohort.campaign_id) ?? { name: cohort.campaign_name, overdue: [], atRisk: [] };
    if (cohort.age_days >= c.payback_target_days) g.overdue.push(cohort);
    else if (cohort.age_days >= 14 && (cohort.projected_payback_day === null || cohort.projected_payback_day > c.payback_target_days)) g.atRisk.push(cohort);
    byCampaign.set(cohort.campaign_id, g);
  }
  for (const [campaign, g] of byCampaign) {
    if (!g.overdue.length && !g.atRisk.length) continue;
    const all = [...g.overdue, ...g.atRisk];
    const worst = all.reduce((a, b) => (b.recovered_to_date < a.recovered_to_date ? b : a));
    const parts = [
      g.overdue.length ? `${g.overdue.length} ${g.overdue.length === 1 ? 'cohorte' : 'cohortes'} con ${c.payback_target_days} días o más sin recuperar la inversión` : '',
      g.atRisk.length ? `${g.atRisk.length} ${g.atRisk.length === 1 ? 'cohorte' : 'cohortes'} en riesgo de no recuperarla antes de ${c.payback_target_days} días` : '',
    ].filter(Boolean).join(' y ');
    push({ rule: g.overdue.length ? 'payback_overdue' : 'payback_at_risk', severity: g.overdue.length ? 'serious' : 'warning', campaign_id: campaign, campaign_name: g.name,
      title: `${g.overdue.length ? 'Payback vencido' : 'Payback en riesgo'}: ${g.name}`,
      detail: `${parts}. Peor cohorte: semana del ${shortDate(worst.week_start)}, ${fmtPct(worst.recovered_to_date)} recuperado a ${worst.age_days} días.`,
      current: all.length, threshold: c.payback_target_days, unit: 'days', window: 'cohortes semanales, 13 semanas',
      action: g.overdue.length ? 'Revisar la calidad del tráfico y el costo de bonos antes de reinvertir en esta campaña.' : 'Priorizar retención CRM para estas cohortes o ajustar la inversión de la campaña.' });
  }
  // Calidad de datos: inversión sin reportar
  const last = store.lastSpendDates(tenant);
  for (const [campaign, date] of last) {
    // #5: días de calendario en la hora local del operador, no en UTC (de noche en Colombia ya es «mañana» en UTC)
    const gap = Math.round((Date.parse(localDay(now, i.timezone)) - Date.parse(date)) / DAY);
    const active = base.campaigns.some((m) => m.campaign_id === campaign && m.spend_minor > 0);
    if (active && gap >= c.spend_missing_days) {
      const name = base.campaigns.find((m) => m.campaign_id === campaign)?.campaign_name ?? campaign;
      push({ rule: 'spend_missing', severity: 'serious', campaign_id: campaign, campaign_name: name, title: `Sin reporte de inversión: ${name}`, detail: `Último reporte del ${shortDate(date)} (hace ${gap} ${gap === 1 ? 'día' : 'días'}). CPA, costo por FTD y ROI de esta campaña están subestimados.`, current: gap, threshold: c.spend_missing_days, unit: 'days', window: 'último reporte', action: 'Verificar la conexión con la plataforma o el envío del afiliado.' });
    }
  }
  // Juego responsable: proporción de la cohorte con restricción
  for (const [campaign, share] of store.rgShare(tenant, { to: now, days: 30 })) {
    if (campaign === 'organic' || share.total < c.min_registrations) continue;
    const r = share.restricted / share.total;
    if (r > c.rg_share_max && share.restricted >= c.min_rg_cases) {
      const name = month.campaigns.find((m) => m.campaign_id === campaign)?.campaign_name ?? campaign;
      push({ rule: 'rg_share_high', severity: 'critical', campaign_id: campaign, campaign_name: name, title: `Restricciones de juego responsable altas: ${name}`, detail: `${share.restricted} de ${share.total} jugadores (${fmtPct(r)}) con autoexclusión, pausa o límite; umbral ${fmtPct(c.rg_share_max)}.`, current: r, threshold: c.rg_share_max, unit: 'ratio', window: '30 d', action: 'Revisar con el responsable de juego responsable la segmentación y las creatividades. No optimizar esta campaña por ROI hasta revisarla.' });
    }
  }
  // Presupuesto de bonos CRM
  for (const b of i.budgets) {
    const u = b.budget_minor > 0 ? b.committed_minor / b.budget_minor : 0;
    if (u >= c.budget_warn) push({ rule: 'bonus_budget', severity: u >= c.budget_serious ? 'serious' : 'warning', title: `Presupuesto de bonos al ${fmtPct(u)}: ${b.name ?? b.reward_id}`, detail: `${fmtMoney(b.committed_minor)} comprometidos de ${fmtMoney(b.budget_minor)}. Al agotarse, los recorridos dejan de otorgar este bono.`, current: u, threshold: c.budget_warn, unit: 'ratio', window: 'acumulado', action: 'Aprobar ampliación de presupuesto o pausar los recorridos que otorgan este bono.' });
  }
  const rank: Record<Severity, number> = { critical: 0, serious: 1, warning: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.title.localeCompare(b.title));
}

/** Configuración y reconocimientos por tenant (en producción: PostgreSQL). */
export class KpiAlertCenter {
  #config = new Map<string, KpiAlertConfig>();
  #acks = new Map<string, { by: string; at: string; note?: string }>();
  config(tenant: string) { return this.#config.get(tenant) ?? DEFAULT_ALERT_CONFIG; }
  setConfig(tenant: string, patch: Partial<KpiAlertConfig>) {
    const next = { ...this.config(tenant) };
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_ALERT_CONFIG) || typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw Object.assign(new Error(`valor inválido para ${k}`), { code: 'invalid_config' });
      (next as Record<string, number>)[k] = v;
    }
    this.#config.set(tenant, next);
    return next;
  }
  acknowledge(tenant: string, id: string, by: string, at: string, note?: string) { this.#acks.set(`${tenant}::${id}`, { by, at, note }); }
  withAcks(tenant: string, alerts: KpiAlert[]) { return alerts.map((a) => ({ ...a, acknowledged: this.#acks.get(`${tenant}::${a.id}`) })); }
}
