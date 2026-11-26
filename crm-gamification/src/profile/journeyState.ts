/**
 * Recorrido del jugador para Perfil 360: en qué etapa está, qué tiene pendiente y cuál es la
 * próxima acción PERMITIDA. La acción sale de las decisiones del servicio de políticas (nunca las
 * contradice): si el marketing está suprimido, la próxima acción es de servicio o ninguna.
 */
import type { Decision } from '../policy/policyEngine.ts';
import type { PlayerProfile } from './projection.ts';
import type { Progress } from '../loyalty/loyalty.ts';

export type StageStatus = 'hecho' | 'actual' | 'pendiente' | 'bloqueado' | 'sin_fuente';
export type Stage = { key: string; label: string; status: StageStatus; detail: string };
export type NextAction = { kind: 'marketing' | 'servicio' | 'ninguna'; label: string; channel?: string; why: string };
export type JourneyState = { stage: string; stages: Stage[]; pending: string[]; next_action: NextAction };

export type JourneyInputs = {
  profile: PlayerProfile;
  now: Date;
  marketing: Record<string, Decision>;
  incentive: Decision;
  loyalty?: Progress | null;
  grants?: number;
  open_predictions?: number;
  spins_left?: number;
};

const REASON: Record<string, string> = {
  rg_status_missing: 'falta el estado de juego responsable',
  rg_feed_stale: 'el estado de juego responsable está desactualizado',
  rg_risk_case_open: 'hay un caso de riesgo abierto',
  kyc_required_for_incentive: 'KYC sin verificar',
  incentives_not_allowed_in_market: 'el mercado no permite incentivos',
  quiet_hours: 'horario silencioso',
};
export function reasonText(r: string): string {
  const [k, v] = r.split(':');
  if (REASON[r]) return REASON[r];
  if (k === 'rg_restricted') return `juego responsable: ${({ self_excluded: 'autoexclusión', cooling_off: 'pausa voluntaria', limited: 'con límites' } as Record<string, string>)[v] ?? v}`;
  if (k === 'no_marketing_consent') return `sin consentimiento de marketing en ${v}`;
  if (k === 'marketing_consent_revoked') return `consentimiento de marketing retirado en ${v}`;
  if (k === 'channel_disabled') return `canal ${v} desactivado en el mercado`;
  if (k === 'frequency_cap' || /cap/.test(k)) return `tope de frecuencia alcanzado${v ? ` (${v})` : ''}`;
  return r.replace(/_/g, ' ');
}

const DAY = 86_400_000;

export function journeyState(i: JourneyInputs): JourneyState {
  const p = i.profile;
  const rg = p.rg?.value;
  const kyc = p.kyc?.value ?? 'pending';
  const restricted = !rg || rg !== 'none';
  const closed = rg === 'self_excluded';
  const s = p.stats;
  const stages: Stage[] = [
    { key: 'registro', label: 'Registro', status: p.registered_at ? 'hecho' : 'pendiente', detail: p.registered_at ? `desde ${p.registered_at.slice(0, 10)}` : 'sin evento de registro' },
    { key: 'verificacion', label: 'Verificación (KYC)', status: kyc === 'verified' ? 'hecho' : kyc === 'rejected' ? 'bloqueado' : 'pendiente', detail: kyc === 'verified' ? `verificado (${p.kyc?.source})` : kyc === 'rejected' ? 'rechazado en el PAM' : 'pendiente en el PAM' },
    { key: 'primer_deposito', label: 'Primer depósito', status: s.deposit_count > 0 ? 'hecho' : 'pendiente', detail: s.first_deposit_at ? `el ${s.first_deposit_at.slice(0, 10)}` : 'sin depósitos confirmados' },
    { key: 'activacion', label: 'Activación (primera apuesta)', status: s.bets_count > 0 ? 'hecho' : 'pendiente', detail: s.bets_count > 0 ? `${s.bets_count} apuestas` : 'aún no apuesta' },
    { key: 'recompensas', label: 'Recompensas', status: (i.grants ?? p.rewards.length) > 0 ? 'hecho' : 'pendiente', detail: `${i.grants ?? p.rewards.length} otorgadas` },
    { key: 'fidelidad', label: 'Fidelidad', status: i.loyalty && i.loyalty.points > 0 ? 'hecho' : 'pendiente', detail: i.loyalty ? `nivel ${i.loyalty.level}, ${i.loyalty.points} pts` : 'sin programa en la marca' },
    { key: 'soporte', label: 'Soporte', status: 'sin_fuente', detail: 'el PAM aún no expone casos de soporte' },
    { key: 'juego_responsable', label: 'Juego responsable', status: !rg ? 'bloqueado' : rg === 'none' ? 'hecho' : 'bloqueado', detail: !rg ? 'sin estado: se bloquea el marketing' : rg === 'none' ? 'sin restricciones' : reasonText(`rg_restricted:${rg}`) },
    { key: 'baja', label: 'Baja / autoexclusión', status: closed ? 'actual' : 'pendiente', detail: closed ? 'autoexcluido: solo mensajes de servicio' : 'cuenta activa' },
  ];
  // etapa actual: la primera del embudo que no está hecha (o «baja» si está autoexcluido)
  const funnel = stages.slice(0, 6);
  const current = closed ? stages[8] : funnel.find((x) => x.status !== 'hecho') ?? stages[5];
  if (!closed && current.status === 'pendiente') current.status = 'actual';

  const pending: string[] = [];
  if (kyc === 'pending') pending.push('Completar la verificación de identidad (KYC) en el PAM');
  for (const r of p.rewards) {
    const left = Date.parse(r.expires_at) - i.now.getTime();
    if (left > 0 && left < 3 * DAY) pending.push(`Recompensa ${r.reward_type} vence en ${Math.ceil(left / 3_600_000)} h`);
  }
  if (i.open_predictions) pending.push(`${i.open_predictions} predicción(es) abierta(s) sin elegir`);
  if (i.spins_left) pending.push(`${i.spins_left} giro(s) disponible(s) hoy`);
  const noConsent = Object.entries(i.marketing).filter(([, d]) => d.reasons.some((r) => r.startsWith('no_marketing_consent'))).map(([c]) => c);
  if (noConsent.length && !restricted) pending.push(`Sin consentimiento de marketing en: ${noConsent.join(', ')}`);

  const allowed = Object.entries(i.marketing).find(([, d]) => d.kind === 'allow')?.[0];
  const deferred = Object.entries(i.marketing).find(([, d]) => d.kind === 'defer');
  const blockers = [...new Set(Object.values(i.marketing).flatMap((d) => d.reasons))].filter((r) => !r.startsWith('no_marketing_consent') && !r.startsWith('channel_disabled'));
  let next: NextAction;
  if (restricted) next = { kind: 'servicio', label: 'Solo mensajes de servicio y de juego responsable', why: `Marketing bloqueado: ${blockers.map(reasonText).join('; ') || 'restricción de juego responsable'}` };
  else if (kyc === 'rejected') next = { kind: 'servicio', label: 'Derivar a soporte: KYC rechazado', why: 'Sin KYC no hay incentivos ni depósito' };
  else if (!allowed) next = deferred
    ? { kind: 'ninguna', label: `Esperar: se reintenta ${deferred[1].defer_until ? `a las ${deferred[1].defer_until.slice(11, 16)} UTC` : 'más tarde'}`, channel: deferred[0], why: deferred[1].reasons.map(reasonText).join('; ') }
    : blockers.length && blockers.every((r) => /cap/.test(r))
      ? { kind: 'ninguna', label: 'Esperar: se alcanzó el tope de mensajes de marketing', why: 'Los topes de frecuencia del mercado ya se cumplieron; se puede volver a contactar cuando se liberen' }
      : { kind: 'ninguna', label: 'No contactar por marketing', why: blockers.length ? [...new Set(blockers.map(reasonText))].join('; ') : 'sin consentimiento de marketing en ningún canal' };
  else if (kyc !== 'verified') next = { kind: 'servicio', label: 'Recordar la verificación de identidad (sin incentivo)', channel: allowed, why: `El incentivo está suprimido: ${i.incentive.reasons.map(reasonText).join('; ')}` };
  else if (s.deposit_count === 0) next = { kind: 'marketing', label: 'Invitar al primer depósito', channel: allowed, why: i.incentive.kind === 'allow' ? 'Elegible para marketing e incentivos' : `Sin incentivo: ${i.incentive.reasons.map(reasonText).join('; ')}` };
  else if (s.bets_count === 0) next = { kind: 'marketing', label: 'Sugerir un primer juego', channel: allowed, why: 'Depositó pero aún no apuesta' };
  else if (i.loyalty?.next_level && i.loyalty.percent_to_next >= 50) next = { kind: 'marketing', label: `Avisar que está cerca de ${i.loyalty.next_level} (${i.loyalty.points_to_next} pts)`, channel: allowed, why: `${i.loyalty.percent_to_next} % del camino al siguiente nivel` };
  else next = { kind: 'marketing', label: 'Mantener: misión o torneo vigente', channel: allowed, why: 'Jugador activo y elegible' };

  return { stage: current.key, stages, pending, next_action: next };
}
