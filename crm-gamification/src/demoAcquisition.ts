import { ev, type App } from './app.ts';
import type { EventEnvelope } from './domain/events.ts';
import { DAY, HOUR, stableBucket } from './shared/util.ts';
import { DEFAULT_POLICY } from './policy/policyEngine.ts';

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
  /** Escenarios de demo para las alertas de KPI. */
  ctrLast7?: number; stopsReportingDays?: number; rgRisk?: number;
  impressions: number; ctr: number; clickToReg: number; ftdRate: number;
  costPerClick: number; depositAvg: number; activityDecayDays: number; baseActivity: number;
};

/** Campañas sintéticas con calidades distintas (no son cifras reales de mercado). */
const CAMPAIGNS: CampaignProfile[] = [
  { id: 'google_search_brand', name: 'Google Search · Marca', channel: 'google', impressions: 420, ctr: 0.085, clickToReg: 0.13, ftdRate: 0.56, costPerClick: 4_200, depositAvg: 80_000, activityDecayDays: 32, baseActivity: 0.5 },
  { id: 'meta_prospecting', name: 'Meta · Prospección', channel: 'meta', ctrLast7: 0.55, impressions: 5_200, ctr: 0.012, clickToReg: 0.065, ftdRate: 0.38, costPerClick: 3_400, depositAvg: 70_000, activityDecayDays: 16, baseActivity: 0.42 },
  { id: 'afiliados_cpa', name: 'Afiliados · CPA', channel: 'affiliate', stopsReportingDays: 3, impressions: 1_300, ctr: 0.021, clickToReg: 0.09, ftdRate: 0.47, costPerClick: 6_200, depositAvg: 80_000, activityDecayDays: 20, baseActivity: 0.45 },
  { id: 'tiktok_awareness', name: 'TikTok · Alcance', channel: 'tiktok', rgRisk: 0.12, impressions: 9_000, ctr: 0.0055, clickToReg: 0.032, ftdRate: 0.2, costPerClick: 2_600, depositAvg: 45_000, activityDecayDays: 6, baseActivity: 0.32 },
];
const ORGANIC_PER_DAY = 1.6;

/**
 * Historia sintética de adquisición: inversión diaria por campaña, registros atribuidos,
 * FTD, depósitos, apuestas con premios y actividad que decae con el tiempo.
 */
export function seedAcquisitionHistory(app: App, tenant: string, days = 60, scale = 1, seed = 7) {
  const r = rng(seed);
  const now = app.clock.now().getTime();
  seedDemoMissions(app, tenant, now);
  seedDemoOverlap(app, tenant);
  seedDemoSplit(app, tenant);
  // demo: bono de bienvenida con valor y presupuesto realistas para el volumen simulado
  const item = app.rewards.item(tenant, 'welcome_fs_10');
  if (item) app.rewards.addItem({ ...item, value: { amount_minor: 20_000_00, currency: 'COP' }, budget_minor: 20_000_00 * 2_000 });
  const events: EventEnvelope[] = [];
  const iso = (t: number) => new Date(Math.min(t, now - 60_000)).toISOString();
  const poisson = (lambda: number) => { let k = 0; const L = Math.exp(-lambda); let p = 1; do { k++; p *= r(); } while (p > L); return k - 1; };
  let n = 0;

  const lifecycle = (player: string, regAt: number, c: CampaignProfile | null) => {
    const prof = c ?? { ftdRate: 0.42, depositAvg: 75_000, activityDecayDays: 22, baseActivity: 0.45 } as CampaignProfile;
    events.push(ev(tenant, player, 'player.registered', { email_masked: `u***${n}@demo.test`, country: 'CO', locale: 'es', timezone: 'America/Bogota', device_hash: `dev-${player}`, ...(c ? { acquisition: { campaign_id: c.id, channel: c.channel } } : {}) }, iso(regAt)));
    events.push(ev(tenant, player, 'rg.status_changed', { status: r() < (c?.rgRisk ?? 0.03) ? 'self_excluded' : 'none' }, iso(regAt + 60_000)));
    events.push(ev(tenant, player, 'consent.changed', { purpose: 'marketing', channel: 'inapp', granted: r() < 0.85 }, iso(regAt + 60_000)));
    events.push(ev(tenant, player, 'consent.changed', { purpose: 'marketing', channel: 'email', granted: r() < 0.6 }, iso(regAt + 60_000)));
    // consentimientos de los canales nuevos con hash estable (no altera la secuencia aleatoria de la demo)
    for (const [ch, rate] of [['sms', 0.5], ['whatsapp', 0.35], ['telegram', 0.12]] as const) if (stableBucket(`${player}:${ch}`) < rate) events.push(ev(tenant, player, 'consent.changed', { purpose: 'marketing', channel: ch, granted: true }, iso(regAt + 120_000)));
    if (r() < 0.82) events.push(ev(tenant, player, 'player.verified', { kyc_status: 'verified' }, iso(regAt + (2 + r() * 30) * HOUR)));
    if (r() >= prof.ftdRate) return;
    const ftdAt = regAt + r() * 2 * DAY;
    if (ftdAt >= now) return;
    const dep = (at: number) => {
      const amount = Math.round((prof.depositAvg * (0.4 + r() * 1.4)) / 1000) * 1000 * 100;
      events.push(ev(tenant, player, 'deposit.settled', { deposit_id: `${player}-d${events.length}`, amount_minor: amount, currency: 'COP', instrument_hash: `card-${player}` }, iso(at)));
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
      const clicks = Math.round(impressions * c.ctr * (d < 7 && c.ctrLast7 ? c.ctrLast7 : 1) * (0.8 + r() * 0.4));
      const spend = Math.round((clicks * c.costPerClick * (0.9 + r() * 0.2)) / 100) * 100 * 100;
      if (!(c.stopsReportingDays && d < c.stopsReportingDays)) events.push(ev(tenant, '', 'marketing.spend_reported', { campaign_id: c.id, campaign_name: c.name, channel: c.channel, date, impressions, clicks, spend: { amount_minor: spend, currency: 'COP' } }, iso(dayStart), { source: `ads.${c.channel}` }));
      const regs = poisson(clicks * c.clickToReg);
      for (let i = 0; i < regs; i++) lifecycle(`acq_${c.channel}_${String(++n).padStart(4, '0')}`, dayStart - r() * 20 * HOUR, c);
    }
    const organic = poisson(ORGANIC_PER_DAY * scale);
    for (let i = 0; i < organic; i++) lifecycle(`acq_org_${String(++n).padStart(4, '0')}`, dayStart - r() * 20 * HOUR, null);
  }
  // demo G9: un anillo de cuentas con el mismo dispositivo que cobra bonos y retira enseguida,
  // y algunos jugadores con un solo ciclo bono → retiro (nivel «vigilar»)
  const abuseCase = (player: string, startAt: number, device: string, cycles: number, depositCop = 30_000) => {
    events.push(ev(tenant, player, 'player.registered', { email_masked: `r***${player}@demo.test`, country: 'CO', locale: 'es', timezone: 'America/Bogota', device_hash: device }, iso(startAt)));
    events.push(ev(tenant, player, 'rg.status_changed', { status: 'none' }, iso(startAt + 60_000)));
    events.push(ev(tenant, player, 'player.verified', { kyc_status: 'verified' }, iso(startAt + HOUR)));
    events.push(ev(tenant, player, 'deposit.settled', { deposit_id: `${player}-d`, amount_minor: depositCop * 100, currency: 'COP', instrument_hash: `card-${player}` }, iso(startAt + 2 * HOUR)));
    for (let c = 0; c < cycles; c++) {
      const t0 = startAt + 3 * HOUR + c * 2 * DAY;
      events.push(ev(tenant, player, 'reward.granted', { grant_id: `${player}-bon${c}`, reward_type: 'bonus', value: { amount_minor: 20_000_00, currency: 'COP' }, expires_at: new Date(t0 + 7 * DAY).toISOString() }, iso(t0), { source: 'ss1.bonus' }));
      events.push(ev(tenant, player, 'bet.settled', { bet_id: `${player}-bet${c}`, stake: { amount_minor: 10_000_00, currency: 'COP' }, win: { amount_minor: 18_000_00, currency: 'COP' }, product: 'casino' }, iso(t0 + HOUR)));
      events.push(ev(tenant, player, 'withdrawal.settled', { withdrawal_id: `${player}-w${c}`, amount_minor: 35_000_00, currency: 'COP' }, iso(t0 + 4 * HOUR)));
    }
  };
  // demo I2: dos jugadores que persiguen pérdidas en las últimas horas (casos altos para el equipo JR)
  for (const [i, pl] of ['rg_chase_01', 'rg_chase_02'].entries()) {
    const reg = now - (40 + 10 * i) * DAY;
    events.push(ev(tenant, pl, 'player.registered', { email_masked: `c***${i}@demo.test`, country: 'CO', locale: 'es', timezone: 'America/Bogota', device_hash: `dev-${pl}` }, iso(reg)));
    events.push(ev(tenant, pl, 'rg.status_changed', { status: 'none' }, iso(reg + 60_000)));
    events.push(ev(tenant, pl, 'consent.changed', { purpose: 'marketing', channel: 'inapp', granted: true }, iso(reg + 60_000)));
    events.push(ev(tenant, pl, 'consent.changed', { purpose: 'marketing', channel: 'email', granted: true }, iso(reg + 60_000)));
    events.push(ev(tenant, pl, 'player.verified', { kyc_status: 'verified' }, iso(reg + HOUR)));
    const start = now - (6 + 3 * i) * HOUR;
    for (let k = 0; k < 5; k++) {
      const t0 = start + k * 25 * 60_000;
      events.push(ev(tenant, pl, 'deposit.settled', { deposit_id: `${pl}-d${k}`, amount_minor: 200_000_00, currency: 'COP', instrument_hash: `card-${pl}` }, iso(t0)));
      events.push(ev(tenant, pl, 'bet.settled', { bet_id: `${pl}-b${k}`, stake: { amount_minor: 200_000_00, currency: 'COP' }, win: { amount_minor: 10_000_00, currency: 'COP' }, product: 'casino' }, iso(t0 + 10 * 60_000)));
    }
  }
  for (let i = 1; i <= 5; i++) abuseCase(`ring_${String(i).padStart(2, '0')}`, now - (18 - i) * DAY, 'dev-ring-01', 2);
  for (let i = 1; i <= 4; i++) abuseCase(`fast_wd_${String(i).padStart(2, '0')}`, now - (20 - 2 * i) * DAY, `dev-fast-${i}`, 1, 250_000);
  // demo B3: segunda marca del mismo operador. La campaña de TikTok y sus jugadores pertenecen a «rumbabet»,
  // con su propia política y programa de fidelidad (los recorridos de rumbawin no la alcanzan)
  const SECOND = 'rumbabet';
  app.policy.setPolicy(tenant, { ...DEFAULT_POLICY, brand_id: SECOND, version: 'co-rumbabet-2026.11.1' });
  app.loyalty.setProgram({ tenant_id: tenant, brand_id: SECOND, season: '2026-Q4', points_per_major_unit: 0.001, halfway_notice: true, levels: [{ name: 'Bronce', threshold: 0 }, { name: 'Plata', threshold: 1000 }, { name: 'Oro', threshold: 5000 }] });
  const secondPlayers = new Set(events.filter((e) => e.event_type === 'player.registered' && (e.payload as { acquisition?: { campaign_id: string } }).acquisition?.campaign_id === 'tiktok_awareness').map((e) => e.player_id));
  for (const e of events) if (secondPlayers.has(e.player_id) || (e.event_type === 'marketing.spend_reported' && (e.payload as { campaign_id: string }).campaign_id === 'tiktok_awareness')) e.brand_id = SECOND;
  events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  // Reproduce la historia en el tiempo: el reloj avanza con los eventos y cada hora simulada
  // se procesan esperas y diferidos, así bonos y mensajes quedan con su fecha real.
  const clock = app.clock as { advance?: (ms: number) => void; now(): Date };
  const replay = typeof clock.advance === 'function' && events.length > 0;
  if (replay) clock.advance!(Date.parse(events[0].occurred_at) - clock.now().getTime());
  let lastHour = -1;
  for (const e of events) {
    if (replay) {
      const delta = Date.parse(e.occurred_at) - clock.now().getTime();
      if (delta > 0) clock.advance!(delta);
      const hour = Math.floor(clock.now().getTime() / HOUR);
      if (hour !== lastHour) { lastHour = hour; for (const t of app.tenants) app.policy.markRgFeedSynced(t); app.runtime.runDue(); }
    }
    app.ingestor.ingest(e);
  }
  if (replay) {
    clock.advance!(now - clock.now().getTime());
    for (const t of app.tenants) app.policy.markRgFeedSynced(t);
    app.runtime.runDue();
  }
  seedDemoOnsite(app, tenant);
  // demo: presupuesto de bonos calibrado para quedar cerca del umbral de alerta
  const b = app.rewards.budget(tenant, 'welcome_fs_10');
  const it = app.rewards.item(tenant, 'welcome_fs_10');
  if (b && it && b.committed_minor > 0) app.rewards.addItem({ ...it, budget_minor: Math.round(b.committed_minor / 0.86 / 100) * 100 });
  return { events: events.length, players: n };
}

/** Misiones de demostración activas en los últimos 30 días (una con bono, aprobada por otra persona). */
export function seedDemoMissions(app: App, tenant: string, now: number) {
  const analyst = { id: 'analyst@ss1', tenant_id: tenant };
  const approver = { id: 'approver@ss1', tenant_id: tenant, canApprove: true };
  const window = { starts_at: new Date(now - 30 * DAY).toISOString(), ends_at: new Date(now + 7 * DAY).toISOString() };
  const ms = [
    { id: 'm_sports_5', brand_id: 'rumbawin', name: '5 apuestas deportivas', description: 'Liquida 5 apuestas de deportes', kind: 'count' as const, event_type: 'bet.settled' as const, product: 'sports' as const, target: 5, reward: { xp: 200 }, ...window },
    { id: 'm_deposit_streak', brand_id: 'rumbawin', name: 'Racha de depósitos', description: 'Deposita 3 días seguidos', kind: 'streak' as const, event_type: 'deposit.settled' as const, target: 3, reward: { xp: 300 }, ...window },
    { id: 'm_casino_20', brand_id: 'rumbawin', name: '20 rondas de casino', description: 'Liquida 20 apuestas de casino y gana free spins', kind: 'count' as const, event_type: 'bet.settled' as const, product: 'casino' as const, target: 20, reward: { reward_id: 'welcome_fs_10' }, ...window },
  ];
  for (const m of ms) {
    if (app.gamification.get(tenant, m.id)) continue;
    app.gamification.save(analyst, m);
    app.gamification.activate({ ...analyst, canApprove: false }, m.id);
    if (m.reward.reward_id) app.gamification.activate(approver, m.id);
  }
  if (!app.games.tournament(tenant, 't_sports_week')) {
    app.games.saveTournament(analyst, { id: 't_sports_week', brand_id: 'rumbawin', name: 'Semana deportiva', metric: 'bet_count', product: 'sports', starts_at: new Date(now - 7 * DAY).toISOString(), ends_at: new Date(now + 2 * DAY).toISOString(), min_score: 3,
      prizes: [{ from: 1, to: 1, prize: { xp: 1000 } }, { from: 2, to: 3, prize: { xp: 500 } }, { from: 4, to: 10, prize: { xp: 100 } }] });
    app.games.activateTournament({ ...analyst, canApprove: false }, 't_sports_week');
  }
  if (!app.store.items(tenant).length) {
    app.store.saveItem(analyst, { id: 's_free_spins', name: 'Free spins de bienvenida', price_coins: 400, stock: 50, per_player_limit: 1, reward: { reward_id: 'welcome_fs_10' }, active: true });
    app.store.saveItem(analyst, { id: 's_xp_boost', name: 'Impulso de 200 XP', price_coins: 150, stock: 1000, per_player_limit: 5, reward: { xp: 200 }, active: true });
    app.store.saveItem(analyst, { id: 's_jersey', name: 'Camiseta oficial RumbaWin', price_coins: 2000, stock: 5, per_player_limit: 1, reward: { physical: 'camiseta' }, active: true });
  }
  if (!app.store.predictions(tenant).length) {
    app.store.savePrediction(analyst, { id: 'p_final', brand_id: 'rumbawin', name: 'Final de la liga', question: '¿Quién gana la final del domingo?', options: ['Local', 'Empate', 'Visitante'], closes_at: new Date(now + 2 * DAY).toISOString(), reward: { coins: 100 } });
  }
  if (!app.games.game(tenant, 'g_daily_wheel')) {
    app.games.saveGame(analyst, { id: 'g_daily_wheel', brand_id: 'rumbawin', name: 'Ruleta diaria', kind: 'wheel', spins_per_day: 1,
      prizes: [{ id: 'none', label: 'Sigue intentando', weight: 55, prize: {} }, { id: 'xp25', label: '25 XP', weight: 30, prize: { xp: 25 } }, { id: 'xp100', label: '100 XP', weight: 12, prize: { xp: 100 } }, { id: 'fs', label: 'Free spins', weight: 3, prize: { reward_id: 'welcome_fs_10' } }] });
  }
}

/** Demo D3: dos recorridos de marketing que compiten por el mismo depósito, en el grupo «promo». */
export function seedDemoOverlap(app: App, tenant: string) {
  const author = { id: 'analyst@ss1', tenant_id: tenant, roles: ['crm_analyst' as const] };
  const approver = { id: 'approver@ss1', tenant_id: tenant, roles: ['approver' as const] };
  const js = [
    { id: 'jd_deposit_progress', name: 'Depósito → aviso de progreso (12 h)', priority: 30, wait: 12 },
    { id: 'jd_deposit_vip', name: 'Depósito → seguimiento VIP (24 h)', priority: 70, wait: 24, condition: true },
  ];
  for (const j of js) {
    app.registry.saveDraft(author, {
      id: j.id, brand_id: 'rumbawin', name: j.name, purpose: 'marketing', control_group_pct: 10, trigger: { event_type: 'deposit.settled' },
      overlap: { group: 'promo', priority: j.priority }, entry: 'wait',
      nodes: j.condition
        ? [{ id: 'wait', type: 'wait', duration_ms: j.wait * HOUR, next: 'big' }, { id: 'big', type: 'condition', rule: { field: 'stats.deposits_minor', op: 'gte', value: 500_000_00 }, on_true: 'msg', on_false: 'end' }, { id: 'msg', type: 'message', channel: 'sms', template: 'loyalty_halfway', next: 'end' }, { id: 'end', type: 'exit' }]
        : [{ id: 'wait', type: 'wait', duration_ms: j.wait * HOUR, next: 'msg' }, { id: 'msg', type: 'message', channel: 'sms', template: 'loyalty_halfway', next: 'end' }, { id: 'end', type: 'exit' }],
    });
    app.registry.submit(author, j.id); app.registry.approve(approver, j.id); app.registry.publish(author, j.id);
  }
}

/** Demo D5: bienvenida con tres variantes optimizadas por primer depósito en 72 h (datos sintéticos neutros). */
export function seedDemoSplit(app: App, tenant: string) {
  const author = { id: 'analyst@ss1', tenant_id: tenant, roles: ['crm_analyst' as const] };
  const approver = { id: 'approver@ss1', tenant_id: tenant, roles: ['approver' as const] };
  app.registry.saveDraft(author, {
    id: 'jab_welcome_message', brand_id: 'rumbawin', name: 'Verificado → mensaje de bienvenida A/B/n', purpose: 'marketing', control_group_pct: 10, trigger: { event_type: 'player.verified' }, entry: 'ab',
    nodes: [
      { id: 'ab', type: 'split', mode: 'bandit', metric: { event: 'deposit.settled', window_hours: 72 }, min_explore_pct: 10, warmup_per_variant: 30,
        variants: [{ id: 'a', label: 'In-app', weight: 1, next: 'inapp' }, { id: 'b', label: 'Email', weight: 1, next: 'email' }, { id: 'c', label: 'Sin mensaje', weight: 1, next: 'end' }, { id: 'd', label: 'WhatsApp', weight: 1, next: 'wa' }] },
      { id: 'wa', type: 'message', channel: 'whatsapp', template: 'loyalty_halfway', next: 'end' },
      { id: 'inapp', type: 'message', channel: 'inapp', template: 'loyalty_halfway', next: 'end' },
      { id: 'email', type: 'message', channel: 'email', template: 'loyalty_halfway', next: 'end' },
      { id: 'end', type: 'exit' }],
  });
  app.registry.submit(author, 'jab_welcome_message'); app.registry.approve(approver, 'jab_welcome_message'); app.registry.publish(author, 'jab_welcome_message');
}

/** Demo F3: banners y popups aprobados, con impresiones y clics sintéticos del día. */
export function seedDemoOnsite(app: App, tenant: string) {
  const author = { id: 'analyst@ss1', tenant_id: tenant };
  const approver = { id: 'approver@ss1', tenant_id: tenant };
  const now = app.clock.now().getTime();
  const win = { starts_at: new Date(now - 20 * DAY).toISOString(), ends_at: new Date(now + 30 * DAY).toISOString() };
  const cs = [
    { id: 'verifica_cuenta', name: 'Completa tu verificación', placement: 'home_banner', purpose: 'service', priority: 90, max_impressions_per_day: 3, rules: { field: 'kyc', op: 'eq', value: 'pending' },
      content: { es: { title: 'Completa tu verificación', body: 'Verifica tu cuenta para depositar y retirar sin demoras.', cta_label: 'Verificar ahora', cta_url: 'https://www.rumbawin.com/perfil/verificacion' } } },
    { id: 'torneo_semana', name: 'Torneo deportivo de la semana', placement: 'home_banner', purpose: 'marketing', priority: 60, max_impressions_per_day: 2, rules: { field: 'lifecycle', op: 'in', value: ['nuevo', 'activo', 'reactivado'] },
      content: { es: { title: 'Torneo de la semana', body: 'Suma puntos con tus apuestas deportivas y sube en la tabla.', cta_label: 'Ver tabla', cta_url: 'https://www.rumbawin.com/torneos' } } },
    { id: 'te_extranamos', name: 'Regreso: misión de bienvenida', placement: 'lobby_popup', purpose: 'marketing', priority: 70, max_impressions_per_day: 1, rules: { field: 'lifecycle', op: 'eq', value: 'en_riesgo' },
      content: { es: { title: 'Te extrañamos', body: 'Tienes una misión esperando: completa 3 apuestas esta semana y gana XP.', cta_label: 'Ver misión', cta_url: 'https://www.rumbawin.com/misiones' } } },
    { id: 'limites_cajero', name: 'Herramientas de control en el cajero', placement: 'cashier_banner', purpose: 'service', priority: 50, max_impressions_per_day: 3, rules: { field: 'stats.deposit_count', op: 'gte', value: 3 },
      content: { es: { title: 'Juega con control', body: 'Puedes fijar un límite de depósito diario, semanal o mensual.', cta_label: 'Fijar límite', cta_url: 'https://www.rumbawin.com/perfil/limites' } } },
  ] as const;
  for (const c of cs) { app.onsite.save(author, { ...c, ...win } as never); app.onsite.submit(author, c.id); app.onsite.approve(approver, c.id); }
  // tráfico sintético: una visita a inicio y al lobby por jugador con actividad en 30 días
  for (const p of app.ingestor.all(tenant)) {
    const last = Date.parse(p.timeline.at(-1)?.occurred_at ?? '1970-01-01');
    if (now - last > 30 * DAY) continue;
    for (const placement of ['home_banner', 'lobby_popup'] as const) {
      const rid = `demo-${p.player_id}-${placement}`;
      const s = app.onsite.serve(p, placement, { request_id: rid });
      if (!s.campaign_id) continue;
      const u = stableBucket(`${rid}:click`);
      if (u < 0.09) app.onsite.track(tenant, p.player_id, { campaign_id: s.campaign_id, type: 'click', request_id: rid });
      else if (u > 0.93) app.onsite.track(tenant, p.player_id, { campaign_id: s.campaign_id, type: 'dismiss', request_id: rid });
    }
  }
}
