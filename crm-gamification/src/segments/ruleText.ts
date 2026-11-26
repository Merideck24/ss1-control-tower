/**
 * Reglas de segmento en lenguaje claro para personas de negocio
 * («{"field":"kyc","op":"eq","value":"pending"}» → «KYC es Pendiente»). La regla técnica no cambia:
 * esto es solo presentación (Aprobación, Constructor, Contenido en sitio).
 */
type Rule = { field?: string; op?: string; value?: unknown; and?: Rule[]; or?: Rule[]; not?: Rule };

const FIELD: Record<string, string> = {
  kyc: 'KYC', rg: 'Juego responsable', 'risk.level': 'Riesgo de juego', country: 'País', locale: 'Idioma', brand_id: 'Marca',
  'stats.deposit_count': 'Número de depósitos', 'stats.deposits_minor': 'Depósitos acumulados', 'stats.bets_count': 'Número de apuestas', 'stats.stake_minor': 'Monto apostado',
  'consent.marketing.email': 'Acepta marketing por email', 'consent.marketing.inapp': 'Acepta marketing in-app', 'consent.marketing.webpush': 'Acepta push web',
  'consent.marketing.sms': 'Acepta marketing por SMS', 'consent.marketing.whatsapp': 'Acepta marketing por WhatsApp', 'consent.marketing.telegram': 'Acepta marketing por Telegram',
  'rewards.active_count': 'Recompensas vigentes', lifecycle: 'Etapa del ciclo de vida', 'rfm.r': 'Recencia (RFM)', 'rfm.f': 'Frecuencia (RFM)', 'rfm.m': 'Valor (RFM)',
  'abuse.tier': 'Riesgo de abuso de bonos', 'loyalty.level': 'Nivel de fidelidad',
};
const VALUE: Record<string, string> = {
  pending: 'Pendiente', verified: 'Verificado', rejected: 'Rechazado', unverified: 'Sin verificar', none: 'Sin restricción', self_excluded: 'Autoexcluido', cooling_off: 'Pausa temporal', limited: 'Con límites',
  high: 'Alto', medium: 'Medio', low: 'Bajo', watch: 'Vigilar', valuable: 'Valioso', new: 'Nuevo', active: 'Activo', at_risk: 'En riesgo', lapsed: 'Inactivo', true: 'sí', false: 'no',
};
const OP: Record<string, string> = { eq: 'es', neq: 'no es', gt: 'mayor que', gte: 'al menos', lt: 'menor que', lte: 'como máximo', in: 'es uno de' };

const money = (minor: number) => (minor / 100).toLocaleString('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const val = (field: string, v: unknown): string => {
  if (Array.isArray(v)) return v.map((x) => val(field, x)).join(', ');
  const t = TYPES[field];
  const named = t?.values?.find(([k]) => k === String(v))?.[1];
  if (named) return named;
  if (t?.type === 'prob' && typeof v === 'number') return `${Math.round(v * 100)} %`;
  if (typeof v === 'number' && /_minor$/.test(field)) return money(v);
  if (typeof v === 'number') return v.toLocaleString('es-CO');
  return VALUE[String(v)] ?? String(v);
};

/** Regla → frase. Ej.: «KYC es Verificado y Número de depósitos al menos 1». */
export function ruleText(r: Rule | undefined | null): string {
  if (!r || typeof r !== 'object') return 'todos los jugadores';
  if (Array.isArray(r.and)) return r.and.map((x) => (x?.or ? `(${ruleText(x)})` : ruleText(x))).join(' y ');
  if (Array.isArray(r.or)) return r.or.map((x) => (x?.and ? `(${ruleText(x)})` : ruleText(x))).join(' o ');
  if (r.not) return `no (${ruleText(r.not)})`;
  const f = String(r.field ?? '');
  const name = FIELD[f] ?? f;
  if (/^consent\./.test(f) && r.op === 'eq' && typeof r.value === 'boolean') return r.value ? name : `No ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
  return `${name} ${OP[String(r.op)] ?? String(r.op)} ${val(f, r.value)}`;
}

/** Tipo de cada campo para el constructor de reglas (formularios): qué operadores y qué valores ofrecer. */
export type FieldMeta = { field: string; label: string; type: 'enum' | 'number' | 'money' | 'bool' | 'prob' | 'text'; values?: [string, string][] };
const E = (...vs: string[]): [string, string][] => vs.map((v) => [v, VALUE[v] ?? v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())]);
const TYPES: Record<string, Omit<FieldMeta, 'field' | 'label'>> = {
  kyc: { type: 'enum', values: E('pending', 'verified', 'rejected') },
  rg: { type: 'enum', values: E('none', 'self_excluded', 'cooling_off', 'limited') },
  'risk.level': { type: 'enum', values: E('none', 'medium', 'high') },
  lifecycle: { type: 'enum', values: [['nuevo', 'Nuevo'], ['sin_deposito', 'Sin depósito'], ['activo', 'Activo'], ['en_riesgo', 'En riesgo'], ['inactivo', 'Inactivo'], ['reactivado', 'Reactivado']] },
  'rfm.segment': { type: 'enum', values: [['campeones', 'Campeones'], ['leales', 'Leales'], ['no_podemos_perderlos', 'No podemos perderlos'], ['en_riesgo', 'En riesgo'], ['potenciales_leales', 'Potenciales leales'], ['nuevos', 'Nuevos'], ['necesitan_atencion', 'Necesitan atención'], ['hibernando', 'Hibernando']] },
  'abuse.tier': { type: 'enum', values: [['ok', 'Sin señales'], ['watch', 'Vigilar'], ['high', 'Alto']] },
  'nba.action': { type: 'enum', values: [['no_contact', 'No contactar'], ['retention_offer', 'Oferta de retención'], ['deposit_nudge', 'Empujón al depósito'], ['reactivation', 'Reactivación'], ['loyalty_progress', 'Progreso de fidelidad'], ['vip_handover', 'Pasar a VIP']] },
  'pred.product': { type: 'enum', values: [['casino', 'Casino'], ['sports', 'Deportes']] },
  'stats.deposit_count': { type: 'number' }, 'stats.bets_count': { type: 'number' }, 'rewards.active_count': { type: 'number' },
  'rfm.r': { type: 'number' }, 'rfm.f': { type: 'number' }, 'rfm.m': { type: 'number' }, 'abuse.score': { type: 'number' },
  'stats.deposits_minor': { type: 'money' }, 'stats.stake_minor': { type: 'money' }, 'pred.value_30d': { type: 'money' },
  'pred.churn': { type: 'prob' }, 'pred.deposit': { type: 'prob' }, 'pred.vip': { type: 'bool' },
};
Object.assign(FIELD, { 'rfm.segment': 'Segmento RFM', 'pred.churn': 'Probabilidad de abandono', 'pred.deposit': 'Probabilidad de depositar (30 d)', 'pred.value_30d': 'Valor previsto (30 d)', 'pred.vip': 'VIP temprano', 'pred.product': 'Producto preferido', persona: 'Persona', 'nba.action': 'Mejor acción siguiente', 'abuse.score': 'Puntaje de abuso de bonos' });
export function fieldMeta(fields: readonly string[]): FieldMeta[] {
  return fields.map((field) => ({ field, label: FIELD[field] ?? field, ...(TYPES[field] ?? (/^consent\./.test(field) ? { type: 'bool' as const } : { type: 'text' as const })) }));
}
