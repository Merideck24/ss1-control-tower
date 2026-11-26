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
