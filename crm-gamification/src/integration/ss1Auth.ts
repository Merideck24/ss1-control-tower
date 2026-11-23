/**
 * Integración con admin.syssoft1.com: el admin autoriza con CASL (`{ action, subject }`).
 * Aquí se traducen esos permisos a roles del CRM. Es la única tabla de mapeo: la usan
 * el modo embebido (UI) y el servidor (A2), que es quien tiene la autoridad final.
 */
import type { Role } from '../journeys/registry.ts';

export type CaslRule = { action: string | string[]; subject: string | string[]; inverted?: boolean };

/** Sujetos CASL del admin que concede cada rol del CRM. `manage` cubre cualquier acción. */
export const ROLE_RULES: Record<Role, { subjects: string[]; actions: string[] }[]> = {
  crm_analyst: [{ subjects: ['crm', 'crm-campaign', 'bonus-campaign', 'telegram-campaign'], actions: ['create', 'update', 'manage'] }],
  approver: [{ subjects: ['crm-approval', 'bonus-campaign'], actions: ['approve', 'manage'] }],
  support: [{ subjects: ['player', 'crm', 'chat-support'], actions: ['read', 'manage'] }],
  rg_officer: [{ subjects: ['kyc', 'responsible-gaming', 'player-limit'], actions: ['update', 'manage'] }],
  tenant_admin: [{ subjects: ['all', 'client', 'crm-settings'], actions: ['manage'] }],
  auditor: [{ subjects: ['audit-log', 'report', 'crm'], actions: ['read', 'manage'] }],
  copilot: [],
};

const list = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

/** Devuelve los roles del CRM que concede un conjunto de reglas CASL. Las reglas invertidas restan. */
export function abilitiesToRoles(rules: readonly CaslRule[]): Role[] {
  const allows = (subject: string, action: string) => {
    let ok = false;
    for (const r of rules) {
      const subj = list(r.subject), act = list(r.action);
      const hit = (subj.includes(subject) || subj.includes('all')) && (act.includes(action) || act.includes('manage'));
      if (hit) ok = !r.inverted;
    }
    return ok;
  };
  const out: Role[] = [];
  for (const [role, grants] of Object.entries(ROLE_RULES) as [Role, (typeof ROLE_RULES)[Role]][]) {
    if (grants.some((g) => g.subjects.some((s) => g.actions.some((a) => allows(s, a))))) out.push(role);
  }
  return out;
}

/** Mensajes del protocolo de embebido (versión 1). */
export type EmbedSession = {
  type: 'ss1-crm:session';
  version: 1;
  accessToken: string;
  tenantId: string;
  user: { id: string; name?: string };
  abilities: CaslRule[];
  locale?: 'es' | 'en' | 'pt';
};

export function isEmbedSession(m: unknown): m is EmbedSession {
  const x = m as Record<string, unknown>;
  return !!x && x.type === 'ss1-crm:session' && x.version === 1 && typeof x.accessToken === 'string' && x.accessToken.length > 10 && typeof x.tenantId === 'string' && /^[\w.-]{1,64}$/.test(x.tenantId)
    && !!x.user && typeof (x.user as Record<string, unknown>).id === 'string' && Array.isArray(x.abilities);
}

/** Orígenes del admin aceptados por defecto. Se amplía solo por configuración de despliegue, nunca por URL. */
export const DEFAULT_ALLOWED_ORIGINS = ['https://admin.syssoft1.com'];
