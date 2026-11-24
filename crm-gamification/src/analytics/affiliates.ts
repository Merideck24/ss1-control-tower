import { DAY } from '../shared/util.ts';
import type { PlayerFacts } from './performance.ts';

/**
 * H5 · Evaluación temprana de fuentes de adquisición (afiliados y campañas pagas)
 * por la calidad de los jugadores que traen, antes de que el payback sea visible.
 * Señales de los primeros días: primer depósito, valor previsto a 30 días (modelo),
 * actividad a 7 días, abuso de bonos y riesgo de juego. El veredicto compara cada
 * fuente contra el promedio de todas las fuentes del mismo período.
 */
export type SourceQuality = {
  campaign_id: string; name: string; channel: string; registrations: number; ftd: number; ftd_rate: number;
  predicted_value_30d_minor: number | null; d7_active_rate: number | null; abuse_share: number; rg_share: number;
  spend_minor: number; cost_per_ftd_minor: number | null; value_to_cpa: number | null;
  verdict: 'buena' | 'vigilar' | 'mala' | 'sin_datos'; reasons: string[];
};

export function sourceQuality(input: {
  facts: readonly Readonly<PlayerFacts>[]; now: number; days: number;
  predictedValue: (player: string) => number | null | undefined;
  abuseFlag: (player: string) => boolean; rgCase: (player: string) => boolean;
  spend: (campaign: string) => number; name: (campaign: string) => { name: string; channel: string };
  minRegs?: number;
}): { baseline: { ftd_rate: number; predicted_value_30d_minor: number | null; d7_active_rate: number | null; value_to_cpa: number | null }; sources: SourceQuality[] } {
  const from = input.now - input.days * DAY;
  const cohort = input.facts.filter((f) => f.registered_at >= from && f.registered_at <= input.now);
  const by = new Map<string, Readonly<PlayerFacts>[]>();
  for (const f of cohort) by.set(f.campaign_id, [...(by.get(f.campaign_id) ?? []), f]);
  const stats = (ps: readonly Readonly<PlayerFacts>[]) => {
    const ftd = ps.filter((p) => p.ftd_at !== undefined);
    const vals = ftd.map((p) => input.predictedValue(p.player_id)).filter((v): v is number => typeof v === 'number');
    const aged = ps.filter((p) => p.registered_at + 7 * DAY <= input.now);
    const d7 = aged.filter((p) => p.bets.some((b) => b.at >= p.registered_at + 7 * DAY && b.at < p.registered_at + 14 * DAY) || [...p.deposits.values()].some((d) => d.at >= p.registered_at + 7 * DAY && d.at < p.registered_at + 14 * DAY));
    return { regs: ps.length, ftd: ftd.length, ftd_rate: ps.length ? ftd.length / ps.length : 0, value: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null, d7: aged.length ? d7.length / aged.length : null,
      abuse: ps.length ? ps.filter((p) => input.abuseFlag(p.player_id)).length / ps.length : 0, rg: ps.length ? ps.filter((p) => input.rgCase(p.player_id)).length / ps.length : 0 };
  };
  const base = stats(cohort);
  // referencia de valor/CPA: promedio ponderado de las fuentes pagas (a 30 días casi nunca se cubre el CPA completo)
  let paidVal = 0, paidSpend = 0;
  for (const [id, ps] of by) { const sp = input.spend(id); if (sp <= 0) continue; const s = stats(ps); if (s.value === null) continue; paidVal += s.value * s.ftd; paidSpend += sp; }
  const baseV2c = paidSpend > 0 ? paidVal / paidSpend : null;
  const minRegs = input.minRegs ?? 20;
  const sources: SourceQuality[] = [...by].map(([id, ps]) => {
    const s = stats(ps);
    const meta = input.name(id);
    const spend = input.spend(id);
    const cpf = s.ftd ? spend / s.ftd : null;
    const v2c = s.value !== null && cpf ? s.value / cpf : null;
    const reasons: string[] = [];
    let bad = 0, watch = 0;
    if (s.regs < minRegs) return { campaign_id: id, name: meta.name, channel: meta.channel, registrations: s.regs, ftd: s.ftd, ftd_rate: s.ftd_rate, predicted_value_30d_minor: s.value === null ? null : Math.round(s.value), d7_active_rate: s.d7, abuse_share: s.abuse, rg_share: s.rg, spend_minor: spend, cost_per_ftd_minor: cpf === null ? null : Math.round(cpf), value_to_cpa: v2c, verdict: 'sin_datos' as const, reasons: [`menos de ${minRegs} registros en el período`] };
    if (base.ftd_rate > 0 && s.ftd_rate < 0.7 * base.ftd_rate) { watch++; reasons.push(`primer depósito ${Math.round(s.ftd_rate * 100)} % vs. ${Math.round(base.ftd_rate * 100)} % promedio`); }
    if (base.value && s.value !== null && s.value < 0.6 * base.value) { bad++; reasons.push(`valor previsto a 30 días ${Math.round((100 * s.value) / base.value)} % del promedio`); }
    if (base.d7 && s.d7 !== null && s.d7 < 0.7 * base.d7) { watch++; reasons.push(`actividad a 7 días ${Math.round(s.d7 * 100)} % vs. ${Math.round(base.d7 * 100)} %`); }
    if (s.abuse > Math.max(0.05, 2 * base.abuse)) { bad++; reasons.push(`${Math.round(s.abuse * 100)} % de jugadores con señales de abuso de bonos`); }
    if (s.rg > Math.max(0.08, 2 * base.rg)) { watch++; reasons.push(`${Math.round(s.rg * 100)} % con casos de riesgo de juego`); }
    if (v2c !== null && baseV2c) {
      const rel = v2c / baseV2c;
      if (rel < 0.5) { bad++; reasons.push(`valor previsto por peso invertido ${Math.round(rel * 100)} % del promedio de fuentes pagas`); }
      else if (rel < 0.8) { watch++; reasons.push(`valor previsto por peso invertido ${Math.round(rel * 100)} % del promedio de fuentes pagas`); }
    }
    const verdict = bad ? 'mala' : watch >= 2 ? 'vigilar' : watch ? 'vigilar' : 'buena';
    if (!reasons.length) reasons.push('en línea o por encima del promedio');
    return { campaign_id: id, name: meta.name, channel: meta.channel, registrations: s.regs, ftd: s.ftd, ftd_rate: s.ftd_rate, predicted_value_30d_minor: s.value === null ? null : Math.round(s.value), d7_active_rate: s.d7, abuse_share: s.abuse, rg_share: s.rg, spend_minor: spend, cost_per_ftd_minor: cpf === null ? null : Math.round(cpf), value_to_cpa: v2c, verdict, reasons };
  });
  const order = { mala: 0, vigilar: 1, buena: 2, sin_datos: 3 };
  return { baseline: { ftd_rate: base.ftd_rate, predicted_value_30d_minor: base.value === null ? null : Math.round(base.value), d7_active_rate: base.d7, value_to_cpa: baseV2c }, sources: sources.sort((a, b) => order[a.verdict] - order[b.verdict] || b.registrations - a.registrations) };
}
