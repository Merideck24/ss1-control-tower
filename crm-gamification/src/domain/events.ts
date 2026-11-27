/**
 * Contratos de eventos normalizados (ver contracts/events.asyncapi.yaml).
 * Todo evento lleva envelope común; montos en unidades mínimas + moneda ISO.
 */
import { DomainError } from '../shared/util.ts';

export const EVENT_TYPES = [
  'player.registered',
  'player.verified',
  'consent.changed',
  'rg.status_changed',
  'deposit.settled',
  'deposit.reversed',
  'bet.settled',
  'reward.granted',
  'loyalty.threshold_crossed',
  'loyalty.level_up',
  'marketing.spend_reported',
  'withdrawal.settled',
  'rg.risk_signal',
  'player.activity',
] as const;

/** Eventos que no pertenecen a un jugador (no actualizan la proyección). */
export const NON_PLAYER_EVENTS: readonly EventType[] = ['marketing.spend_reported'];
export type EventType = (typeof EVENT_TYPES)[number];

export const CHANNELS = ['inapp', 'email', 'webpush', 'sms', 'whatsapp', 'telegram'] as const;
export type Channel = (typeof CHANNELS)[number];
export type Purpose = 'service' | 'marketing';
export type RgStatus = 'none' | 'cooling_off' | 'self_excluded' | 'limited';
export type KycStatus = 'pending' | 'verified' | 'rejected';

export type Money = { amount_minor: number; currency: string };

export type PayloadByType = {
  'player.registered': { email_masked: string; country: string; locale: string; timezone: string; acquisition?: { campaign_id: string; channel?: string }; /** huella de dispositivo seudonimizada (hash), nunca el valor crudo */ device_hash?: string };
  'player.verified': { kyc_status: KycStatus };
  'consent.changed': { purpose: Purpose; channel: Channel; granted: boolean };
  'rg.status_changed': { status: RgStatus };
  'deposit.settled': { deposit_id: string; /** hash del medio de pago (tokenizado por la pasarela) */ instrument_hash?: string } & Money;
  'deposit.reversed': { deposit_id: string } & Money;
  'bet.settled': { bet_id: string; stake: Money; win?: Money; product: 'casino' | 'sports' };
  'reward.granted': { grant_id: string; reward_type: 'free_bet' | 'free_spins' | 'bonus'; value: Money; expires_at: string };
  'loyalty.threshold_crossed': { level: string; season: string; percent: number };
  /** el jugador subió de nivel (solo subidas; una vez por nivel y temporada) */
  'loyalty.level_up': { level: string; previous_level: string; season: string };
  'withdrawal.settled': { withdrawal_id: string } & Money;
  /** I2: señal interna del monitor de riesgo (fuente crm.risk); dispara intervenciones, no promociones. */
  'rg.risk_signal': { level: 'medium' | 'high'; score: number; signals: string[] };
  /** Actividad del jugador en el sitio o la app (fuente ss1.site): completar el perfil, visitar una función, guardar preferencias. Sin datos personales. */
  'player.activity': { action: 'profile_completed' | 'feature_visited' | 'preferences_saved'; feature?: string };
  /** Inversión diaria agregada por campaña (fuente: plataformas de medios / afiliados). */
  'marketing.spend_reported': { campaign_id: string; campaign_name: string; channel: string; date: string; impressions: number; clicks: number; spend: Money };
};

export type EventEnvelope<T extends EventType = EventType> = {
  event_id: string;
  event_type: T;
  schema_version: number;
  tenant_id: string;
  brand_id: string;
  player_id: string; // seudonimizado
  occurred_at: string; // UTC ISO
  received_at?: string;
  source: string;
  correlation_id: string;
  aggregate_version?: number;
  payload: PayloadByType[T];
};

const SUPPORTED_SCHEMA: Record<EventType, number[]> = Object.fromEntries(
  EVENT_TYPES.map((t) => [t, [1]]),
) as Record<EventType, number[]>;

/** Claves que nunca deben viajar en eventos (CRM-05). */
const FORBIDDEN_KEYS = /token|secret|password|otp|magic_link|reset_link/i;

export function validateEnvelope(e: unknown): asserts e is EventEnvelope {
  const ev = e as Record<string, unknown>;
  const required = ['event_id', 'event_type', 'schema_version', 'tenant_id', 'brand_id', 'occurred_at', 'source', 'correlation_id', 'payload'];
  if (!NON_PLAYER_EVENTS.includes(ev?.event_type as EventType)) required.push('player_id');
  for (const k of required) {
    if (ev?.[k] === undefined || ev[k] === null || ev[k] === '') throw new DomainError('invalid_event', `missing field: ${k}`);
  }
  if (!EVENT_TYPES.includes(ev.event_type as EventType)) throw new DomainError('unknown_event_type', String(ev.event_type));
  if (!SUPPORTED_SCHEMA[ev.event_type as EventType].includes(ev.schema_version as number)) {
    throw new DomainError('unsupported_schema', `${ev.event_type} v${ev.schema_version}`);
  }
  if (Number.isNaN(Date.parse(ev.occurred_at as string))) throw new DomainError('invalid_event', 'occurred_at not ISO-8601');
  const scan = (obj: unknown, path: string): void => {
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (FORBIDDEN_KEYS.test(k)) throw new DomainError('secret_in_event', `forbidden key ${path}${k}`);
        scan(v, `${path}${k}.`);
      }
    }
  };
  scan(ev.payload, 'payload.');
  const p = ev.payload as Record<string, unknown>;
  for (const m of [p, p.stake, p.value, p.win, p.spend]) {
    if (m && typeof m === 'object' && 'amount_minor' in m) {
      const mm = m as Money;
      if (!Number.isInteger(mm.amount_minor)) throw new DomainError('invalid_money', 'amount_minor must be integer');
      if (!/^[A-Z]{3}$/.test(mm.currency)) throw new DomainError('invalid_money', 'currency must be ISO-4217');
    }
  }
}
