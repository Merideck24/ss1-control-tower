import { createApp, ev, seedTenant } from '../src/app.ts';
import { ManualClock } from '../src/shared/util.ts';

export const T = 'tenant-rumbawin';
export const T2 = 'tenant-other';

export function setup(at = '2026-11-15T15:00:00Z') {
  const clock = new ManualClock(at); // 10:00 Bogotá
  const app = createApp(clock);
  seedTenant(app, T);
  seedTenant(app, T2);
  return { app, clock };
}

/** Jugador elegible para marketing: registrado, KYC ok, JR ok, consentimientos. */
export function onboard(app: ReturnType<typeof createApp>, clock: ManualClock, player: string, tenant = T, opts: { verify?: boolean; email?: boolean } = {}) {
  const now = () => clock.now().toISOString();
  app.ingestor.ingest(ev(tenant, player, 'player.registered', { email_masked: 'a***@mail.com', country: 'CO', locale: 'es', timezone: 'America/Bogota' }, now()));
  app.ingestor.ingest(ev(tenant, player, 'rg.status_changed', { status: 'none' }, now()));
  app.ingestor.ingest(ev(tenant, player, 'consent.changed', { purpose: 'marketing', channel: 'inapp', granted: true }, now()));
  if (opts.email !== false) app.ingestor.ingest(ev(tenant, player, 'consent.changed', { purpose: 'marketing', channel: 'email', granted: true }, now()));
  if (opts.verify !== false) app.ingestor.ingest(ev(tenant, player, 'player.verified', { kyc_status: 'verified' }, now()));
}

export { ev };
