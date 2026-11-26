/**
 * Variables de las plantillas: cuáles aporta cada disparador y cómo se le muestran al jugador.
 * El constructor usa TRIGGER_VARS para avisar si una plantilla pide algo que el disparador no
 * trae; el canal, además, nunca envía un mensaje con una variable vacía.
 */
import type { EventEnvelope, EventType } from '../domain/events.ts';

type Locale = 'es' | 'en' | 'pt';
const INTL: Record<Locale, string> = { es: 'es-CO', en: 'en-US', pt: 'pt-BR' };

/** Siempre disponibles, sea cual sea el disparador. */
export const COMMON_VARS = ['player_id'] as const;
/** Variables que aporta el evento que inicia el recorrido. */
export const TRIGGER_VARS: Partial<Record<EventType, readonly string[]>> = {
  'reward.granted': ['reward_type', 'amount', 'currency', 'expires_at'],
  'loyalty.threshold_crossed': ['level', 'percent'],
  'deposit.settled': ['amount', 'currency'],
  'withdrawal.settled': ['amount', 'currency'],
};
export const varsForTrigger = (t?: string) => [...COMMON_VARS, ...((t && TRIGGER_VARS[t as EventType]) ?? [])];

/** Nombre de cada evento disparador para personas (la clave técnica sigue en la definición). */
export const EVENT_LABEL: Record<string, string> = {
  'player.registered': 'Registro', 'player.verified': 'Jugador verificado', 'deposit.settled': 'Depósito acreditado', 'deposit.reversed': 'Depósito revertido',
  'withdrawal.settled': 'Retiro pagado', 'bet.settled': 'Apuesta liquidada', 'reward.granted': 'Recompensa otorgada', 'loyalty.threshold_crossed': 'Cruce del 50 % del nivel',
  'rg.risk_signal': 'Señal de riesgo de juego responsable', 'rg.status_changed': 'Cambio de estado de juego responsable', 'consent.changed': 'Cambio de consentimiento',
  'marketing.spend_reported': 'Inversión reportada',
};
export const eventLabel = (t?: string) => (t && EVENT_LABEL[t]) ?? t ?? '—';

const REWARD_LABEL: Record<string, Record<Locale, string>> = {
  free_spins: { es: 'giros gratis', en: 'free spins', pt: 'rodadas grátis' },
  bonus_cash: { es: 'saldo de bono', en: 'bonus cash', pt: 'saldo de bônus' },
  cashback: { es: 'reembolso', en: 'cashback', pt: 'cashback' },
  free_bet: { es: 'apuesta gratis', en: 'free bet', pt: 'aposta grátis' },
};
export const rewardLabel = (type: string, locale: Locale = 'es') => REWARD_LABEL[type]?.[locale] ?? type.replace(/_/g, ' ');

const FMT = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
const fmt = <T extends Intl.NumberFormat | Intl.DateTimeFormat>(key: string, make: () => T): T => { let f = FMT.get(key) as T | undefined; if (!f) { f = make(); FMT.set(key, f); } return f; };
/** Monto en unidades mínimas → texto para el jugador (sin decimales en monedas como COP). */
export function moneyText(minor: number, currency: string, locale: Locale = 'es') {
  const zero = ['COP', 'CLP', 'PYG', 'JPY', 'KRW'].includes(currency);
  return fmt(`m|${locale}|${currency}`, () => new Intl.NumberFormat(INTL[locale], { style: 'currency', currency, maximumFractionDigits: zero ? 0 : 2, minimumFractionDigits: zero ? 0 : 2 })).format(minor / 100);
}
export const dateText = (iso: string, locale: Locale = 'es') => fmt(`d|${locale}`, () => new Intl.DateTimeFormat(INTL[locale], { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' })).format(new Date(iso));

/** Valores listos para el jugador a partir del evento disparador. `amount` ya incluye la moneda. */
export function buildVars(player_id: string, e: EventEnvelope | undefined, locale: Locale = 'es'): Record<string, string | number> {
  const v: Record<string, string | number> = { player_id };
  if (e?.event_type === 'reward.granted') {
    const p = (e as EventEnvelope<'reward.granted'>).payload;
    v.reward_type = rewardLabel(p.reward_type, locale); v.amount = moneyText(p.value.amount_minor, p.value.currency, locale); v.currency = p.value.currency; v.expires_at = dateText(p.expires_at, locale);
  }
  if (e?.event_type === 'loyalty.threshold_crossed') {
    const p = (e as EventEnvelope<'loyalty.threshold_crossed'>).payload;
    v.level = p.level; v.percent = p.percent;
  }
  if (e?.event_type === 'deposit.settled' || e?.event_type === 'withdrawal.settled') {
    const p = (e as EventEnvelope<'deposit.settled'>).payload;
    v.amount = moneyText(p.amount_minor, p.currency, locale); v.currency = p.currency;
  }
  return v;
}
