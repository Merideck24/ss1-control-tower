import type { Channel, Purpose } from '../domain/events.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import { DAY, HOUR, type Clock } from '../shared/util.ts';

/** Reglas por marca y mercado, versionadas y aprobadas por Compliance (CRM-08). */
export type MarketPolicy = {
  version: string;
  brand_id: string;
  market: string; // ISO country
  channels_enabled: Channel[];
  max_marketing_per_day: number;
  /** D4: tope diario por canal (además del tope global). */
  max_marketing_per_day_by_channel?: Partial<Record<Channel, number>>;
  /** D4: tope de 7 días móviles entre todos los canales. */
  max_marketing_per_week?: number;
  quiet_hours: { start: number; end: number }; // local hours, [start, end)
  incentives_allowed: boolean;
  rg_feed_max_staleness_ms: number;
  require_kyc_for_incentives: boolean;
};

export type DecisionKind = 'allow' | 'suppress' | 'defer';
export type Decision = {
  kind: DecisionKind;
  reasons: string[];
  policy_version: string;
  defer_until?: string;
  alert?: string;
};

export type DecisionRequest = {
  profile: PlayerProfile;
  purpose: Purpose;
  channel?: Channel;
  incentive?: boolean; // acción con costo (bono, free spin…)
};

export const DEFAULT_POLICY: MarketPolicy = {
  version: 'co-rumbawin-2026.11.1',
  brand_id: 'rumbawin',
  market: 'CO',
  channels_enabled: ['inapp', 'email', 'webpush'],
  max_marketing_per_day: 2,
  max_marketing_per_day_by_channel: { email: 1, webpush: 1, inapp: 2 },
  max_marketing_per_week: 6,
  quiet_hours: { start: 22, end: 8 },
  incentives_allowed: true,
  rg_feed_max_staleness_ms: 6 * HOUR,
  require_kyc_for_incentives: true,
};

const HOUR_FMT = new Map<string, Intl.DateTimeFormat>();
function localHour(d: Date, tz: string): number {
  let f = HOUR_FMT.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }); HOUR_FMT.set(tz, f); }
  const h = f.format(d);
  return Number(h) % 24;
}

function inQuiet(h: number, q: { start: number; end: number }): boolean {
  return q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
}

/**
 * Servicio de políticas determinista. Autoridad de bloqueo: ni recorridos ni copiloto
 * pueden saltarlo. Ante restricción crítica ausente/desactualizada → suprime marketing
 * e incentivos y emite alerta operativa (fail-closed).
 */
export class PolicyEngine {
  #policies = new Map<string, MarketPolicy>();
  #rgFeedSync = new Map<string, string>(); // tenant → last successful sync ISO
  #sends = new Map<string, { at: number; channel?: Channel }[]>(); // tenant::player → envíos de marketing
  #alerts: { at: string; tenant_id: string; player_id: string; alert: string }[] = [];
  #clock: Clock;
  constructor(clock: Clock) { this.#clock = clock; }

  setPolicy(tenant_id: string, p: MarketPolicy): void { this.#policies.set(`${tenant_id}::${p.brand_id}::${p.market}`, p); }
  policyFor(profile: PlayerProfile): MarketPolicy | undefined {
    return this.#policies.get(`${profile.tenant_id}::${profile.brand_id}::${profile.country?.value ?? '??'}`);
  }
  markRgFeedSynced(tenant_id: string, at = this.#clock.now().toISOString()): void { this.#rgFeedSync.set(tenant_id, at); }
  alerts() { return [...this.#alerts]; }

  recordMarketingSend(profile: PlayerProfile, channel?: Channel): void {
    const k = `${profile.tenant_id}::${profile.player_id}`;
    const now = this.#clock.now().getTime();
    // se conservan 7 días: lo necesario para el tope semanal
    this.#sends.set(k, [...(this.#sends.get(k) ?? []).filter((s) => now - s.at < 7 * DAY), { at: now, channel }]);
  }
  /** Envíos de marketing del jugador en las últimas 24 h y 7 días, por canal. */
  frequency(profile: PlayerProfile) {
    const now = this.#clock.now().getTime();
    const all = this.#sends.get(`${profile.tenant_id}::${profile.player_id}`) ?? [];
    const day = all.filter((s) => now - s.at < DAY);
    const by: Partial<Record<Channel, number>> = {};
    for (const s of day) if (s.channel) by[s.channel] = (by[s.channel] ?? 0) + 1;
    return { last_24h: day.length, last_7d: all.filter((s) => now - s.at < 7 * DAY).length, by_channel_24h: by };
  }

  decide(req: DecisionRequest): Decision {
    const { profile, purpose, channel, incentive } = req;
    const now = this.#clock.now();
    const policy = this.policyFor(profile);
    const reasons: string[] = [];
    const alert = (msg: string) => { this.#alerts.push({ at: now.toISOString(), tenant_id: profile.tenant_id, player_id: profile.player_id, alert: msg }); return msg; };

    if (!policy) {
      return { kind: 'suppress', reasons: ['no_policy_for_market'], policy_version: 'none', alert: alert('missing market policy') };
    }
    const v = policy.version;
    if (channel && !policy.channels_enabled.includes(channel)) reasons.push(`channel_disabled:${channel}`);

    if (purpose === 'service') {
      if (channel && profile.consents[`service:${channel}`]?.value === false) reasons.push('service_channel_opt_out');
      return reasons.length ? { kind: 'suppress', reasons, policy_version: v } : { kind: 'allow', reasons: ['service_message'], policy_version: v };
    }

    // --- marketing / incentives: fail-closed on critical restrictions ---
    let alertMsg: string | undefined;
    const lastSync = this.#rgFeedSync.get(profile.tenant_id);
    if (!profile.rg) { reasons.push('rg_status_missing'); alertMsg = alert('rg status missing'); }
    else {
      if (!lastSync || now.getTime() - Date.parse(lastSync) > policy.rg_feed_max_staleness_ms) { reasons.push('rg_feed_stale'); alertMsg = alert('rg feed stale'); }
      if (profile.rg.value !== 'none') reasons.push(`rg_restricted:${profile.rg.value}`);
    }

    if (channel) {
      const c = profile.consents[`marketing:${channel}`];
      if (!c) reasons.push(`no_marketing_consent:${channel}`);
      else if (!c.value) reasons.push(`marketing_consent_revoked:${channel}`);
    }
    if (incentive) {
      if (!policy.incentives_allowed) reasons.push('incentives_not_allowed_in_market');
      if (policy.require_kyc_for_incentives && profile.kyc?.value !== 'verified') reasons.push('kyc_not_verified');
    }
    if (channel) {
      const f = this.frequency(profile);
      if (f.last_24h >= policy.max_marketing_per_day) reasons.push('frequency_cap');
      const perChannel = policy.max_marketing_per_day_by_channel?.[channel];
      if (perChannel !== undefined && (f.by_channel_24h[channel] ?? 0) >= perChannel) reasons.push(`frequency_cap_channel:${channel}`);
      if (policy.max_marketing_per_week !== undefined && f.last_7d >= policy.max_marketing_per_week) reasons.push('frequency_cap_week');
    }

    if (reasons.length) return { kind: 'suppress', reasons, policy_version: v, alert: alertMsg };

    if (channel && channel !== 'inapp') {
      const tz = profile.timezone?.value ?? 'UTC';
      if (inQuiet(localHour(now, tz), policy.quiet_hours)) {
        let t = now.getTime();
        while (inQuiet(localHour(new Date(t), tz), policy.quiet_hours)) t += 15 * 60_000;
        return { kind: 'defer', reasons: ['quiet_hours'], policy_version: v, defer_until: new Date(t).toISOString() };
      }
    }
    return { kind: 'allow', reasons: ['eligible'], policy_version: v };
  }
}
