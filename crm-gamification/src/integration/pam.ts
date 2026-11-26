/**
 * Frontera con el PAM de SS1 (docs/PAM_INTEGRATION.md).
 *
 * El CRM solo LEE del PAM: los conectores dependen de `PamSource`, no de un cliente HTTP concreto.
 * Implementaciones intercambiables:
 *   - `Ss1Client` (HTTP al admin de SS1, con reintentos y paginación) — piloto y producción;
 *   - `SandboxPam` (filas en memoria con la forma del admin) — desarrollo, pruebas de contrato y demo.
 * Cualquier adaptador nuevo (otro PAM, un bus de eventos) debe pasar la misma suite: test/pam_contract.test.ts.
 */
import { SS1_ENDPOINTS, type ConnectorName } from './ss1Connectors.ts';

export type PamRow = Record<string, unknown>;

/** Lo único que el CRM necesita del PAM: listar filas de un recurso, con filtros. Sin escrituras. */
export interface PamSource {
  paginate(path: string, query?: Record<string, string | number | undefined>): AsyncIterable<PamRow>;
}

/** Quién es dueño de cada dato. El CRM nunca escribe un dato del PAM; lo deriva de eventos. */
export const PAM_OWNERSHIP = {
  pam: ['identidad y registro', 'KYC', 'juego responsable (autoexclusión, límites)', 'saldo y transacciones financieras', 'apuestas y premios', 'bonos otorgados por el PAM'],
  crm: ['consentimientos de marketing por canal', 'segmentos y etapas del ciclo de vida', 'recorridos, mensajes y recibos', 'misiones, puntos de fidelidad y monedas', 'grupos de control y experimentos'],
  rule: 'Si el PAM y el CRM discrepan en un dato del PAM, gana el PAM y el CRM lo vuelve a leer; si falta un dato de JR, el CRM bloquea (fail-closed).',
} as const;

/** Alcances mínimos que la credencial de servicio debe tener en el admin de SS1. Solo lectura. */
export const PAM_SCOPES: Record<ConnectorName, string> = {
  players: 'players:read',
  financial: 'transactions:read',
  withdrawals: 'withdrawals:read',
  games: 'transactions:read',
};

/** Fases de activación. Cada una tiene una puerta de salida medible antes de pasar a la siguiente. */
export const PAM_ROLLOUT = [
  { stage: 'sandbox', source: 'SandboxPam', effects: 'simulados', gate: 'suite de contrato en verde con filas reales anonimizadas de SS1' },
  { stage: 'piloto', source: 'Ss1Client (solo lectura)', effects: 'in-app de una marca, sin incentivos', gate: '14 días: conciliación de depósitos ±0,5 % contra el reporte diario del admin, 0 envíos a autoexcluidos' },
  { stage: 'activación gradual', source: 'Ss1Client', effects: '10 % → 50 % → 100 % de jugadores por hash estable', gate: 'sin alertas críticas abiertas, tasa de fallas de envío < 1 %, aprobación de Compliance por paso' },
] as const;

/** Porcentaje de jugadores activos en la fase gradual: hash estable, el mismo jugador siempre cae igual. */
export function inRollout(playerId: string, percent: number): boolean {
  let h = 2166136261;
  for (const ch of playerId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h % 100 < Math.max(0, Math.min(100, percent));
}

/**
 * PAM de prueba con la forma real del admin (listas `{ data, pagination: { total_pages } }`).
 * Registra cada lectura para que las pruebas verifiquen qué se pidió.
 */
export class SandboxPam implements PamSource {
  readonly calls: { path: string; query: Record<string, string | number | undefined> }[] = [];
  #rows: Map<string, PamRow[]>;
  #pageSize: number;
  constructor(rows: Partial<Record<ConnectorName, PamRow[]>>, opts: { pageSize?: number } = {}) {
    this.#rows = new Map(Object.entries(rows).map(([k, v]) => [SS1_ENDPOINTS[k as ConnectorName], v ?? []]));
    this.#pageSize = opts.pageSize ?? 100;
  }
  async *paginate(path: string, query: Record<string, string | number | undefined> = {}): AsyncGenerator<PamRow> {
    this.calls.push({ path, query });
    const rows = this.#rows.get(path) ?? [];
    for (let i = 0; i < rows.length; i += this.#pageSize) for (const r of rows.slice(i, i + this.#pageSize)) yield structuredClone(r);
  }
}
