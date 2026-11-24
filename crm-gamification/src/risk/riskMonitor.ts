import type { AuditLog } from '../audit/audit.ts';
import type { EventEnvelope } from '../domain/events.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import { DAY, DomainError, HOUR, type Clock } from '../shared/util.ts';

/**
 * I2 · Monitoreo de riesgo de juego en tiempo real.
 * Señales explicables calculadas al llegar cada evento. Un nivel «medio» o «alto»
 * abre un caso para el equipo de Juego Responsable y emite `rg.risk_signal`, que
 * dispara recorridos de intervención (D6). Mientras haya un caso alto abierto, el
 * motor de políticas suprime marketing e incentivos. No decide restricciones: eso
 * lo hace una persona del equipo JR (y el estado oficial sigue viniendo de SS1).
 */
export const RISK_RULES = {
  version: 'rg-risk-2026.11',
  velocity_count_24h: 4, // ≥ 4 depósitos en 24 h…
  velocity_multiple: 3, // …o depósitos de 24 h ≥ 3× su promedio diario de 30 días
  velocity_min_history_days: 7,
  chase_minutes: 60, // nuevo depósito ≤ 60 min después del anterior…
  chase_loss_share: 0.8, // …habiendo perdido ≥ 80 % de ese depósito
  chase_count_24h: 3,
  night_from: 0, night_to: 6, // 00:00–05:59 hora local
  night_days_7d: 3,
  stake_multiple: 3, // apuesta media de 24 h ≥ 3× la de 30 días
  stake_min_bets: 20,
  medium: 30, high: 60,
  re_alert_hours: 24, // no repetir la misma alerta antes de 24 h
} as const;

export type RiskSignal = { code: 'deposit_velocity' | 'loss_chasing' | 'night_play' | 'escalating_stakes'; points: number; label: string; detail: string };
export type RiskLevel = 'none' | 'medium' | 'high';
export type RiskAssessment = { player_id: string; score: number; level: RiskLevel; signals: RiskSignal[]; as_of: string };
export type RgCase = {
  case_id: string; tenant_id: string; player_id: string; level: Exclude<RiskLevel, 'none'>; score: number; signals: RiskSignal[];
  opened_at: string; status: 'open' | 'in_review' | 'closed'; assignee?: string; outcome?: 'contacted' | 'limits_suggested' | 'escalated_to_rg' | 'no_action'; notes: { at: string; by: string; text: string }[];
};

type Win = { deposits: { at: number; amount: number }[]; bets: { at: number; stake: number; win: number }[]; nightDays: Set<string> };
const hourFmt = new Map<string, Intl.DateTimeFormat>();
function localParts(t: number, tz: string) {
  let f = hourFmt.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23' }); hourFmt.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
const last7Cache = new Map<string, Set<string>>();
/** Días locales de los últimos 7 días (caché por zona y hora). */
function lastDays(now: number, tz: string) {
  const k = `${tz}:${Math.floor(now / HOUR)}`;
  let s = last7Cache.get(k);
  if (!s) { s = new Set<string>(); for (let i = 0; i < 7; i++) s.add(localParts(now - i * DAY, tz).day); if (last7Cache.size > 5000) last7Cache.clear(); last7Cache.set(k, s); }
  return s;
}
const fmtMoney = (minor: number) => `$${Math.round(minor / 100).toLocaleString('es-CO')}`;

export class RiskMonitor {
  #win = new Map<string, Win>();
  #cases = new Map<string, RgCase>();
  #lastAlert = new Map<string, { level: RiskLevel; at: number }>();
  #audit: AuditLog;
  #clock: Clock;
  /** Emisor de `rg.risk_signal` (lo conecta la composición de la app). */
  emit?: (e: EventEnvelope<'rg.risk_signal'>) => void;
  constructor(audit: AuditLog, clock: Clock) { this.#audit = audit; this.#clock = clock; }

  onEvent(e: EventEnvelope, profile: PlayerProfile | undefined): RiskAssessment | undefined {
    if (e.event_type !== 'deposit.settled' && e.event_type !== 'bet.settled') return undefined;
    const k = `${e.tenant_id}::${e.player_id}`;
    const w = this.#win.get(k) ?? { deposits: [], bets: [], nightDays: new Set<string>() };
    const t = Date.parse(e.occurred_at);
    if (e.event_type === 'deposit.settled') w.deposits.push({ at: t, amount: (e as EventEnvelope<'deposit.settled'>).payload.amount_minor });
    else {
      const p = (e as EventEnvelope<'bet.settled'>).payload;
      w.bets.push({ at: t, stake: p.stake.amount_minor, win: p.win?.amount_minor ?? 0 });
      const lp = localParts(t, profile?.timezone?.value ?? 'UTC');
      if (lp.hour >= RISK_RULES.night_from && lp.hour < RISK_RULES.night_to) w.nightDays.add(lp.day);
    }
    // ventana de 30 días
    const cut = t - 30 * DAY;
    w.deposits = w.deposits.filter((d) => d.at >= cut); w.bets = w.bets.filter((b) => b.at >= cut);
    this.#win.set(k, w);
    const a = this.#assess(e.player_id, w, t, profile?.timezone?.value ?? 'UTC');
    if (a.level !== 'none') this.#maybeAlert(e, a, t);
    return a;
  }

  assess(tenant: string, player: string, tz = 'UTC'): RiskAssessment {
    const w = this.#win.get(`${tenant}::${player}`);
    const now = this.#clock.now().getTime();
    return w ? this.#assess(player, w, now, tz) : { player_id: player, score: 0, level: 'none', signals: [], as_of: new Date(now).toISOString() };
  }

  #assess(player: string, w: Win, now: number, tz: string): RiskAssessment {
    const R = RISK_RULES;
    const signals: RiskSignal[] = [];
    const d24 = w.deposits.filter((d) => d.at > now - DAY && d.at <= now);
    const sum24 = d24.reduce((s, d) => s + d.amount, 0);
    const older = w.deposits.filter((d) => d.at <= now - DAY);
    const histDays = older.length ? Math.max(1, (now - DAY - Math.min(...older.map((d) => d.at))) / DAY) : 0;
    const dailyAvg = histDays >= R.velocity_min_history_days ? older.reduce((s, d) => s + d.amount, 0) / Math.min(29, histDays) : 0;
    // un solo depósito grande no es velocidad: el múltiplo exige al menos 2 en 24 h
    if (d24.length >= R.velocity_count_24h || (d24.length >= 2 && dailyAvg > 0 && sum24 >= R.velocity_multiple * dailyAvg)) {
      signals.push({ code: 'deposit_velocity', points: d24.length >= 2 * R.velocity_count_24h ? 40 : 30, label: 'Depósitos acelerados', detail: `${d24.length} depósitos por ${fmtMoney(sum24)} en 24 h${dailyAvg > 0 ? ` (${(sum24 / dailyAvg).toLocaleString('es-CO', { maximumFractionDigits: 1 })}× su promedio diario)` : ''}.` });
    }
    // persecución de pérdidas: redepósito rápido tras perder casi todo el depósito anterior
    let chases = 0;
    const ds = [...w.deposits].sort((a, b) => a.at - b.at);
    for (let i = 1; i < ds.length; i++) {
      const prev = ds[i - 1], cur = ds[i];
      if (cur.at <= now - DAY || cur.at - prev.at > R.chase_minutes * 60_000) continue;
      const net = w.bets.filter((b) => b.at >= prev.at && b.at <= cur.at).reduce((s, b) => s + b.win - b.stake, 0);
      if (-net >= R.chase_loss_share * prev.amount) chases++;
    }
    if (chases >= R.chase_count_24h) signals.push({ code: 'loss_chasing', points: 35, label: 'Persecución de pérdidas', detail: `${chases} veces en 24 h volvió a depositar en menos de ${R.chase_minutes} min tras perder ≥ ${Math.round(R.chase_loss_share * 100)} % del depósito anterior.` });
    const last7 = lastDays(now, tz);
    const nights = [...w.nightDays].filter((d) => last7.has(d)).length;
    if (nights >= R.night_days_7d) signals.push({ code: 'night_play', points: 20, label: 'Juego nocturno frecuente', detail: `Jugó entre ${R.night_from}:00 y ${R.night_to}:00 (hora local) en ${nights} de los últimos 7 días.` });
    const b24 = w.bets.filter((b) => b.at > now - DAY && b.at <= now);
    const bOld = w.bets.filter((b) => b.at <= now - DAY);
    if (bOld.length >= R.stake_min_bets && b24.length >= 5) {
      const avg24 = b24.reduce((s, b) => s + b.stake, 0) / b24.length, avg = bOld.reduce((s, b) => s + b.stake, 0) / bOld.length;
      if (avg24 >= R.stake_multiple * avg) signals.push({ code: 'escalating_stakes', points: 25, label: 'Apuestas en escalada', detail: `Apuesta media de 24 h ${fmtMoney(avg24)}, ${(avg24 / avg).toLocaleString('es-CO', { maximumFractionDigits: 1 })}× su media de 30 días.` });
    }
    const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
    const level: RiskLevel = score >= R.high ? 'high' : score >= R.medium ? 'medium' : 'none';
    return { player_id: player, score, level, signals, as_of: new Date(now).toISOString() };
  }

  #maybeAlert(e: EventEnvelope, a: RiskAssessment, t: number) {
    const k = `${e.tenant_id}::${e.player_id}`;
    const last = this.#lastAlert.get(k);
    const rank = { none: 0, medium: 1, high: 2 };
    const open = this.cases(e.tenant_id).find((c) => c.player_id === e.player_id && c.status !== 'closed');
    // el caso abierto siempre refleja la evaluación más grave vista
    if (open && a.score > open.score) { open.score = a.score; open.signals = a.signals; if (rank[a.level] > rank[open.level]) open.level = a.level as RgCase['level']; }
    if (last && t - last.at < RISK_RULES.re_alert_hours * HOUR && rank[a.level] <= rank[last.level]) return;
    this.#lastAlert.set(k, { level: a.level, at: t });
    if (!open) {
      const c: RgCase = { case_id: `rg-${e.player_id}-${t}`, tenant_id: e.tenant_id, player_id: e.player_id, level: a.level as RgCase['level'], score: a.score, signals: a.signals, opened_at: new Date(t).toISOString(), status: 'open', notes: [] };
      this.#cases.set(c.case_id, c);
      this.#audit.record(e.tenant_id, 'system', 'rg.case_opened', e.player_id, { case_id: c.case_id, level: c.level, signals: a.signals.map((s) => s.code), rules: RISK_RULES.version });
    }
    this.emit?.({ event_id: `risk-${e.event_id}`, event_type: 'rg.risk_signal', schema_version: 1, tenant_id: e.tenant_id, brand_id: e.brand_id, player_id: e.player_id, occurred_at: e.occurred_at, source: 'crm.risk', correlation_id: e.correlation_id,
      payload: { level: a.level as 'medium' | 'high', score: a.score, signals: a.signals.map((s) => s.code) } });
  }

  cases(tenant: string) { return [...this.#cases.values()].filter((c) => c.tenant_id === tenant); }
  /** Caso alto sin cerrar ⇒ el motor de políticas suprime marketing e incentivos. */
  hasOpenHigh(tenant: string, player: string) { return this.cases(tenant).some((c) => c.player_id === player && c.level === 'high' && c.status !== 'closed'); }

  take(actor: { id: string; tenant_id: string }, caseId: string): RgCase {
    const c = this.#get(actor.tenant_id, caseId);
    if (c.status === 'closed') throw new DomainError('case_closed', 'El caso ya está cerrado.');
    c.status = 'in_review'; c.assignee = actor.id;
    this.#audit.record(actor.tenant_id, actor.id, 'rg.case_taken', c.player_id, { case_id: c.case_id });
    return c;
  }
  close(actor: { id: string; tenant_id: string }, caseId: string, outcome: string, note: string): RgCase {
    const c = this.#get(actor.tenant_id, caseId);
    const valid = ['contacted', 'limits_suggested', 'escalated_to_rg', 'no_action'];
    if (!valid.includes(outcome)) throw new DomainError('invalid_outcome', `Resultado no válido. Usa: ${valid.join(', ')}.`);
    if (!note || note.trim().length < 5) throw new DomainError('note_required', 'Describe la gestión (mínimo 5 caracteres).');
    c.status = 'closed'; c.outcome = outcome as RgCase['outcome']; c.notes.push({ at: this.#clock.now().toISOString(), by: actor.id, text: note.trim() });
    c.assignee ??= actor.id;
    this.#audit.record(actor.tenant_id, actor.id, 'rg.case_closed', c.player_id, { case_id: c.case_id, outcome, note: note.trim() });
    return c;
  }
  #get(tenant: string, id: string) {
    const c = this.#cases.get(id);
    if (!c || c.tenant_id !== tenant) throw new DomainError('not_found', `No existe el caso ${id}.`);
    return c;
  }
}
