import { ev, type App } from './app.ts';
import type { EventEnvelope } from './domain/events.ts';
import { DAY, HOUR } from './shared/util.ts';

/** Generador determinista (mulberry32) para que la demo sea reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type CampaignProfile = {
  id: string; name: string; channel: string;
  impressions: number; ctr: number; clickToReg: number; ftdRate: number;
  costPerClick: number; depositAvg: number; activityDecayDays: number; baseActivity: number;
};

/** Campañas sintéticas con calidades distintas (no son cifras reales de mercado). */
const CAMPAIGNS: CampaignProfile[] = [
  { id: 'google_search_brand', name: 'Google Search · Marca', channel: 'google', impressions: 420, ctr: 0.085, clickToReg: 0.13, ftdRate: 0.56, costPerClick: 4_200, depositAvg: 80_000, activityDecayDays: 32, baseActivity: 0.5 },
  { id: 'meta_prospecting', name: 'Meta · Prospección', channel: 'meta', impressions: 5_200, ctr: 0.012, clickToReg: 0.065, ftdRate: 0.38, costPerClick: 3_400, depositAvg: 70_000, activityDecayDays: 16, baseActivity: 0.42 },
  { id: 'afiliados_cpa', name: 'Afiliados · CPA', channel: 'affiliate', impressions: 1_300, ctr: 0.021, clickToReg: 0.09, ftdRate: 0.47, costPerClick: 6_200, depositAvg: 80_000, activityDecayDays: 20, baseActivity: 0.45 },
  { id: 'tiktok_awareness', name: 'TikTok · Alcance', channel: 'tiktok', impressions: 9_000, ctr: 0.0055, clickToReg: 0.032, ftdRate: 0.2, costPerClick: 2_600, depositAvg: 45_000, activityDecayDays: 6, baseActivity: 0.32 },
];
const ORGANIC_PER_DAY = 1.6;

/**
 * Historia sintética de adquisición: inversión diaria por campaña, registros atribuidos,
 * FTD, depósitos, apuestas con premios y actividad que decae con el tiempo.
 */
export function seedAcquisitionHistory(app: App, tenant: string, days = 60, scale = 1, seed = 7) {
  const r = rng(seed);
  const now = app.clock.now().getTime();
  // demo: bono de bienvenida con valor y presupuesto realistas para el volumen simulado
  const item = app.rewards.item(tenant, 'welcome_fs_10');
  if (item) app.rewards.addItem({ ...item, value: { amount_minor: 20_000_00, currency: 'COP' }, budget_minor: 20_000_00 * 2_000 });
  const events: EventEnvelope[] = [];
  const iso = (t: number) => new Date(Math.min(t, now - 60_000)).toISOString();
  const poisson = (lambda: number) => { let k = 0; const L = Math.exp(-lambda); let p = 1; do { k++; p *= r(); } while (p > L); return k - 1; };
  let n = 0;

  const lifecycle = (player: string, regAt: number, c: CampaignProfile | null) => {
    const prof = c ?? { ftdRate: 0.42, depositAvg: 75_000, activityDecayDays: 22, baseActivity: 0.45 } as CampaignProfile;
    events.push(ev(tenant, player, 'player.registered', { email_masked: `u***${n}@demo.test`, country: 'CO', locale: 'es', timezone: 'America/Bogota', ...(c ? { acquisition: { campaign_id: c.id, channel: c.channel } } : {}) }, iso(regAt)));
    events.push(ev(tenant, player, 'rg.status_changed', { status: r() < 0.03 ? 'self_excluded' : 'none' }, iso(regAt + 60_000)));
    events.push(ev(tenant, player, 'consent.changed', { purpose: 'marketing', channel: 'inapp', granted: r() < 0.85 }, iso(regAt + 60_000)));
    events.push(ev(tenant, player, 'consent.changed', { purpose: 'marketing', channel: 'email', granted: r() < 0.6 }, iso(regAt + 60_000)));
    if (r() < 0.82) events.push(ev(tenant, player, 'player.verified', { kyc_status: 'verified' }, iso(regAt + (2 + r() * 30) * HOUR)));
    if (r() >= prof.ftdRate) return;
    const ftdAt = regAt + r() * 2 * DAY;
    if (ftdAt >= now) return;
    const dep = (at: number) => {
      const amount = Math.round((prof.depositAvg * (0.4 + r() * 1.4)) / 1000) * 1000 * 100;
      events.push(ev(tenant, player, 'deposit.settled', { deposit_id: `${player}-d${events.length}`, amount_minor: amount, currency: 'COP' }, iso(at)));
      return amount;
    };
    let bankroll = dep(ftdAt);
    for (let d = 0; ftdAt + d * DAY < now; d++) {
      const active = d === 0 || r() < prof.baseActivity * Math.exp(-d / prof.activityDecayDays);
      if (!active) continue;
      const dayAt = ftdAt + d * DAY + r() * 6 * HOUR;
      if (d > 0 && r() < 0.45) bankroll += dep(dayAt);
      const bets = 2 + Math.floor(r() * 5);
      for (let b = 0; b < bets && bankroll > 0; b++) {
        const stake = Math.max(200_000, Math.round((bankroll * (0.15 + r() * 0.25)) / 100_000) * 100_000);
        const win = r() < 0.42 ? Math.round(stake * (0.5 + r() * 2.6)) : 0; // retención del operador ~10–20 %
        bankroll += win - stake;
        events.push(ev(tenant, player, 'bet.settled', { bet_id: `${player}-b${events.length}`, stake: { amount_minor: stake, currency: 'COP' }, win: { amount_minor: win, currency: 'COP' }, product: r() < 0.7 ? 'casino' : 'sports' }, iso(dayAt + b * 600_000)));
      }
    }
  };

  for (let d = days; d >= 0; d--) {
    const dayStart = now - d * DAY;
    const date = new Date(dayStart).toISOString().slice(0, 10);
    for (const c of CAMPAIGNS) {
      const impressions = Math.round(c.impressions * scale * (0.75 + r() * 0.5));
      const clicks = Math.round(impressions * c.ctr * (0.8 + r() * 0.4));
      const spend = Math.round((clicks * c.costPerClick * (0.9 + r() * 0.2)) / 100) * 100 * 100;
      events.push(ev(tenant, '', 'marketing.spend_reported', { campaign_id: c.id, campaign_name: c.name, channel: c.channel, date, impressions, clicks, spend: { amount_minor: spend, currency: 'COP' } }, iso(dayStart), { source: `ads.${c.channel}` }));
      const regs = poisson(clicks * c.clickToReg);
      for (let i = 0; i < regs; i++) lifecycle(`acq_${c.channel}_${String(++n).padStart(4, '0')}`, dayStart - r() * 20 * HOUR, c);
    }
    const organic = poisson(ORGANIC_PER_DAY * scale);
    for (let i = 0; i < organic; i++) lifecycle(`acq_org_${String(++n).padStart(4, '0')}`, dayStart - r() * 20 * HOUR, null);
  }
  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  for (const e of events) app.ingestor.ingest(e);
  return { events: events.length, players: n };
}
