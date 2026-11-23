import type { Channel, EventEnvelope, KycStatus, Purpose, RgStatus } from '../domain/events.ts';

/** Campo crítico con procedencia: fuente, versión y vigencia (CRM-01). */
export type Tracked<T> = { value: T; source: string; occurred_at: string; event_id: string; version: number };

export type ConsentKey = `${Purpose}:${Channel}`;

export type PlayerProfile = {
  tenant_id: string;
  brand_id: string;
  player_id: string;
  email_masked?: Tracked<string>;
  country?: Tracked<string>;
  locale?: Tracked<string>;
  timezone?: Tracked<string>;
  kyc?: Tracked<KycStatus>;
  rg?: Tracked<RgStatus>;
  consents: Partial<Record<ConsentKey, Tracked<boolean>>>;
  stats: { deposits_minor: number; deposit_count: number; bets_count: number; stake_minor: number; win_minor: number; currency?: string; first_deposit_at?: string; last_deposit_at?: string; last_bet_at?: string };
  acquisition?: { campaign_id: string; channel?: string };
  rewards: { grant_id: string; reward_type: string; amount_minor: number; currency: string; expires_at: string; granted_at: string }[];
  timeline: { event_id: string; event_type: string; occurred_at: string; source: string }[];
  registered_at?: string;
};

export function emptyProfile(tenant_id: string, brand_id: string, player_id: string): PlayerProfile {
  return { tenant_id, brand_id, player_id, consents: {}, stats: { deposits_minor: 0, deposit_count: 0, bets_count: 0, stake_minor: 0, win_minor: 0 }, rewards: [], timeline: [] };
}

/** Last-writer-wins by occurred_at — tolerates out-of-order delivery. */
function track<T>(current: Tracked<T> | undefined, value: T, e: EventEnvelope): Tracked<T> | undefined {
  if (current && Date.parse(current.occurred_at) > Date.parse(e.occurred_at)) return current;
  return { value, source: e.source, occurred_at: e.occurred_at, event_id: e.event_id, version: (current?.version ?? 0) + 1 };
}

/** Pure reducer: applies one (already deduplicated) event to the projection. */
export function applyEvent(p: PlayerProfile, e: EventEnvelope): PlayerProfile {
  const next: PlayerProfile = structuredClone(p);
  next.timeline.push({ event_id: e.event_id, event_type: e.event_type, occurred_at: e.occurred_at, source: e.source });
  next.timeline.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id));
  switch (e.event_type) {
    case 'player.registered': {
      const pl = (e as EventEnvelope<'player.registered'>).payload;
      next.email_masked = track(next.email_masked, pl.email_masked, e);
      next.country = track(next.country, pl.country, e);
      next.locale = track(next.locale, pl.locale, e);
      next.timezone = track(next.timezone, pl.timezone, e);
      next.registered_at ??= e.occurred_at;
      if (pl.acquisition) next.acquisition ??= pl.acquisition;
      next.kyc ??= { value: 'pending', source: e.source, occurred_at: e.occurred_at, event_id: e.event_id, version: 1 };
      break;
    }
    case 'player.verified':
      next.kyc = track(next.kyc, (e as EventEnvelope<'player.verified'>).payload.kyc_status, e);
      break;
    case 'consent.changed': {
      const pl = (e as EventEnvelope<'consent.changed'>).payload;
      const k: ConsentKey = `${pl.purpose}:${pl.channel}`;
      next.consents[k] = track(next.consents[k], pl.granted, e);
      break;
    }
    case 'rg.status_changed':
      next.rg = track(next.rg, (e as EventEnvelope<'rg.status_changed'>).payload.status, e);
      break;
    case 'deposit.settled': {
      const pl = (e as EventEnvelope<'deposit.settled'>).payload;
      next.stats.deposits_minor += pl.amount_minor;
      next.stats.deposit_count += 1;
      next.stats.currency ??= pl.currency;
      if (!next.stats.first_deposit_at || e.occurred_at < next.stats.first_deposit_at) next.stats.first_deposit_at = e.occurred_at;
      if (!next.stats.last_deposit_at || e.occurred_at > next.stats.last_deposit_at) next.stats.last_deposit_at = e.occurred_at;
      break;
    }
    case 'deposit.reversed': {
      const pl = (e as EventEnvelope<'deposit.reversed'>).payload;
      next.stats.deposits_minor -= pl.amount_minor;
      next.stats.deposit_count = Math.max(0, next.stats.deposit_count - 1);
      break;
    }
    case 'bet.settled': {
      const pl = (e as EventEnvelope<'bet.settled'>).payload;
      next.stats.bets_count += 1;
      next.stats.stake_minor += pl.stake.amount_minor;
      next.stats.win_minor += pl.win?.amount_minor ?? 0;
      if (!next.stats.last_bet_at || e.occurred_at > next.stats.last_bet_at) next.stats.last_bet_at = e.occurred_at;
      break;
    }
    case 'reward.granted': {
      const pl = (e as EventEnvelope<'reward.granted'>).payload;
      if (!next.rewards.some((r) => r.grant_id === pl.grant_id)) {
        next.rewards.push({ grant_id: pl.grant_id, reward_type: pl.reward_type, amount_minor: pl.value.amount_minor, currency: pl.value.currency, expires_at: pl.expires_at, granted_at: e.occurred_at });
      }
      break;
    }
    case 'loyalty.threshold_crossed':
      break;
  }
  return next;
}

/** Vista para soporte: contacto enmascarado y procedencia de campos críticos. */
export function profileView(p: PlayerProfile) {
  const field = <T,>(t?: Tracked<T>) => (t ? { value: t.value, source: t.source, as_of: t.occurred_at, version: t.version } : { value: null, source: null, as_of: null, version: 0 });
  return {
    player_id: p.player_id,
    brand_id: p.brand_id,
    contact: { email: field(p.email_masked) },
    kyc: field(p.kyc),
    rg: field(p.rg),
    country: field(p.country),
    timezone: field(p.timezone),
    consents: Object.fromEntries(Object.entries(p.consents).map(([k, v]) => [k, field(v)])),
    stats: p.stats,
    rewards: p.rewards,
    timeline: p.timeline,
  };
}
