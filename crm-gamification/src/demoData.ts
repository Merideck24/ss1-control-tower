import { ev, type App } from './app.ts';
import { HOUR } from './shared/util.ts';

/** Población sintética para demo (sin datos reales). */
export function seedDemoPlayers(app: App, tenant: string, n = 40) {
  const now = () => app.clock.now().toISOString();
  const names = ['ES', 'EN', 'PT'] as const;
  for (let i = 1; i <= n; i++) {
    const id = `ply_${String(i).padStart(4, '0')}`;
    const locale = names[i % 3].toLowerCase();
    app.ingestor.ingest(ev(tenant, id, 'player.registered', { email_masked: `j***${i}@demo.test`, country: 'CO', locale, timezone: 'America/Bogota' }, now()));
    app.ingestor.ingest(ev(tenant, id, 'rg.status_changed', { status: i % 13 === 0 ? 'self_excluded' : i % 17 === 0 ? 'cooling_off' : 'none' }, now()));
    app.ingestor.ingest(ev(tenant, id, 'consent.changed', { purpose: 'marketing', channel: 'inapp', granted: i % 5 !== 0 }, now()));
    app.ingestor.ingest(ev(tenant, id, 'consent.changed', { purpose: 'marketing', channel: 'email', granted: i % 3 !== 0 }, now()));
    if (i % 4 !== 0) app.ingestor.ingest(ev(tenant, id, 'player.verified', { kyc_status: 'verified' }, now()));
    const deposits = i % 6;
    for (let d = 0; d < deposits; d++) app.ingestor.ingest(ev(tenant, id, 'deposit.settled', { deposit_id: `${id}-d${d}`, amount_minor: (20_000 + 10_000 * (i % 7)) * 100, currency: 'COP' }, now()));
    const bets = (i * 7) % 11;
    for (let b = 0; b < bets; b++) app.ingestor.ingest(ev(tenant, id, 'bet.settled', { bet_id: `${id}-b${b}`, stake: { amount_minor: 90_000 * 100, currency: 'COP' }, product: b % 2 ? 'sports' : 'casino' }, now()));
  }
  // deja algunos recordatorios de verificación pendientes y procesa vencimientos
  (app.clock as { advance?: (ms: number) => void }).advance?.(25 * HOUR);
  // el latido del feed JR llega para todos los tenants antes de procesar vencimientos
  for (const t of new Set([...app.tenants, tenant])) app.policy.markRgFeedSynced(t);
  app.runtime.runDue();
}
