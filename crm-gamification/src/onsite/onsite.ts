import type { AuditLog } from '../audit/audit.ts';
import type { Purpose } from '../domain/events.ts';
import type { PolicyEngine } from '../policy/policyEngine.ts';
import type { PlayerProfile } from '../profile/projection.ts';
import { evaluate, validateRules, type RuleNode } from '../segments/segmentEngine.ts';
import { DAY, DomainError, type Clock } from '../shared/util.ts';

/**
 * F3 · Contenido en el sitio: banners y popups por segmento.
 * El sitio pide qué mostrar en una ubicación; el CRM decide con las mismas reglas que
 * los mensajes (consentimiento in-app, juego responsable, casos de riesgo abiertos),
 * respeta prioridad, vigencia, tope diario por jugador y descartes, y mide impresiones
 * y clics. Las campañas requieren aprobación de otra persona.
 */
export const PLACEMENTS = ['home_banner', 'lobby_popup', 'cashier_banner', 'sportsbook_banner'] as const;
export type Placement = (typeof PLACEMENTS)[number];
export type OnsiteContent = { title: string; body: string; cta_label?: string; cta_url?: string; image_url?: string };
export type OnsiteCampaign = {
  id: string; tenant_id: string; name: string; placement: Placement; purpose: Purpose;
  rules: RuleNode; content: Partial<Record<'es' | 'en' | 'pt', OnsiteContent>>;
  priority: number; starts_at: string; ends_at: string; max_impressions_per_day: number; dismiss_days: number;
  status: 'draft' | 'pending_approval' | 'active' | 'paused' | 'ended'; created_by: string; approved_by?: string; updated_at: string;
};
type Interaction = { campaign_id: string; player_id: string; type: 'impression' | 'click' | 'dismiss'; at: number; request_id: string };

export class OnsiteService {
  #campaigns = new Map<string, OnsiteCampaign>();
  #log = new Map<string, Interaction>(); // tenant::request_id::type → interacción (idempotente)
  #audit: AuditLog; #clock: Clock; #policy: PolicyEngine;
  /** Dominios permitidos para los CTA (los de la marca). */
  allowedDomains = ['rumbawin.com', 'syssoft1.com'];
  constructor(deps: { audit: AuditLog; clock: Clock; policy: PolicyEngine }) { this.#audit = deps.audit; this.#clock = deps.clock; this.#policy = deps.policy; }

  #k(t: string, id: string) { return `${t}::${id}`; }
  campaigns(tenant: string) { return [...this.#campaigns.values()].filter((c) => c.tenant_id === tenant); }
  get(tenant: string, id: string) { const c = this.#campaigns.get(this.#k(tenant, id)); if (!c) throw new DomainError('not_found', `No existe la campaña ${id}.`); return c; }

  validate(c: Partial<OnsiteCampaign>): string[] {
    const errs: string[] = [];
    if (!c.id || !/^[\w-]{2,40}$/.test(c.id)) errs.push('El identificador debe tener 2–40 letras, números, guiones o guiones bajos.');
    if (!c.name?.trim()) errs.push('Falta el nombre.');
    if (!PLACEMENTS.includes(c.placement as Placement)) errs.push(`Ubicación no válida. Usa: ${PLACEMENTS.join(', ')}.`);
    if (c.purpose !== 'marketing' && c.purpose !== 'service') errs.push('El propósito debe ser marketing o servicio.');
    const es = c.content?.es;
    if (!es?.title?.trim() || !es.body?.trim()) errs.push('El contenido en español necesita título y texto.');
    for (const [loc, x] of Object.entries(c.content ?? {})) {
      if (!x) continue;
      if ((x.title?.length ?? 0) > 60 || (x.body?.length ?? 0) > 240) errs.push(`Contenido ${loc}: título ≤ 60 y texto ≤ 240 caracteres.`);
      if (/<[^>]+>/.test(`${x.title}${x.body}${x.cta_label ?? ''}`)) errs.push(`Contenido ${loc}: solo texto plano, sin HTML.`);
      for (const u of [x.cta_url, x.image_url]) if (u && !this.#safeUrl(u)) errs.push(`Contenido ${loc}: la URL ${u} debe ser https y de un dominio de la marca.`);
      if (x.cta_url && !x.cta_label) errs.push(`Contenido ${loc}: el enlace necesita un texto de botón.`);
    }
    if (!(Number(c.priority) >= 1 && Number(c.priority) <= 100)) errs.push('La prioridad va de 1 a 100.');
    if (!(Number(c.max_impressions_per_day) >= 1)) errs.push('El tope diario por jugador debe ser al menos 1.');
    if (!c.starts_at || !c.ends_at || Number.isNaN(Date.parse(c.starts_at)) || Date.parse(c.ends_at) <= Date.parse(c.starts_at)) errs.push('La vigencia necesita inicio y fin válidos (fin después del inicio).');
    if (!c.rules) errs.push('Define a quién se muestra (regla de segmento).');
    else for (const e of validateRules(c.rules)) errs.push(e.startsWith('unknown_field:') ? `La regla usa el campo «${e.slice(14)}», que no existe.` : e);
    return errs;
  }
  #safeUrl(u: string) { try { const x = new URL(u); return x.protocol === 'https:' && this.allowedDomains.some((d) => x.hostname === d || x.hostname.endsWith(`.${d}`)); } catch { return false; } }

  save(actor: { id: string; tenant_id: string }, input: Omit<OnsiteCampaign, 'tenant_id' | 'status' | 'created_by' | 'approved_by' | 'updated_at' | 'dismiss_days'> & { dismiss_days?: number }): OnsiteCampaign {
    const errs = this.validate(input);
    if (errs.length) throw new DomainError('invalid_onsite_campaign', errs.join(' '));
    const prev = this.#campaigns.get(this.#k(actor.tenant_id, input.id));
    if (prev && prev.status === 'active') throw new DomainError('campaign_active', 'Pausa la campaña antes de editarla: cada cambio vuelve a requerir aprobación.');
    const c: OnsiteCampaign = { ...structuredClone(input), dismiss_days: input.dismiss_days ?? 7, tenant_id: actor.tenant_id, status: 'draft', created_by: actor.id, updated_at: this.#clock.now().toISOString() };
    this.#campaigns.set(this.#k(actor.tenant_id, c.id), c);
    this.#audit.record(actor.tenant_id, actor.id, 'onsite.saved', c.id, { placement: c.placement, priority: c.priority });
    return c;
  }
  submit(actor: { id: string; tenant_id: string }, id: string) {
    const c = this.get(actor.tenant_id, id);
    if (c.status !== 'draft' && c.status !== 'paused') throw new DomainError('invalid_state', `No se puede enviar desde «${c.status}».`);
    c.status = 'pending_approval'; c.updated_at = this.#clock.now().toISOString();
    this.#audit.record(actor.tenant_id, actor.id, 'onsite.submitted', id, {});
    return c;
  }
  approve(actor: { id: string; tenant_id: string }, id: string) {
    const c = this.get(actor.tenant_id, id);
    if (c.status !== 'pending_approval') throw new DomainError('invalid_state', 'Solo se aprueban campañas pendientes.');
    if (c.created_by === actor.id) throw new DomainError('segregation_of_duties', 'Quien crea la campaña no puede aprobarla.');
    c.status = 'active'; c.approved_by = actor.id; c.updated_at = this.#clock.now().toISOString();
    this.#audit.record(actor.tenant_id, actor.id, 'onsite.approved', id, {});
    return c;
  }
  setPaused(actor: { id: string; tenant_id: string }, id: string, paused: boolean) {
    const c = this.get(actor.tenant_id, id);
    if (paused && c.status !== 'active') throw new DomainError('invalid_state', 'Solo se pausan campañas activas.');
    if (!paused) { if (c.status !== 'paused' || !c.approved_by) throw new DomainError('invalid_state', 'Solo se reanudan campañas pausadas y ya aprobadas.'); }
    c.status = paused ? 'paused' : 'active'; c.updated_at = this.#clock.now().toISOString();
    this.#audit.record(actor.tenant_id, actor.id, paused ? 'onsite.paused' : 'onsite.resumed', id, {});
    return c;
  }

  #count(tenant: string, campaign: string, player: string, type: Interaction['type'], since: number) {
    let n = 0;
    for (const [k, x] of this.#log) if (k.startsWith(`${tenant}::`) && x.campaign_id === campaign && x.player_id === player && x.type === type && x.at >= since) n++;
    return n;
  }

  /** Qué mostrar a un jugador en una ubicación. Devuelve el motivo cuando no hay nada. */
  serve(profile: PlayerProfile, placement: Placement, opts: { locale?: string; request_id: string }) {
    const now = this.#clock.now(), t = now.getTime();
    const tenant = profile.tenant_id;
    const skipped: { campaign_id: string; reason: string }[] = [];
    const candidates = this.campaigns(tenant).filter((c) => c.placement === placement && c.status === 'active' && Date.parse(c.starts_at) <= t && Date.parse(c.ends_at) > t).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    for (const c of candidates) {
      if (!evaluate(c.rules, profile, now)) { skipped.push({ campaign_id: c.id, reason: 'fuera_del_segmento' }); continue; }
      const d = this.#policy.decide({ profile, purpose: c.purpose, channel: 'inapp', surface: 'onsite' });
      if (d.kind !== 'allow' && !(d.kind === 'defer')) { skipped.push({ campaign_id: c.id, reason: `politica:${d.reasons.join(',')}` }); continue; }
      if (this.#count(tenant, c.id, profile.player_id, 'dismiss', t - c.dismiss_days * DAY) > 0) { skipped.push({ campaign_id: c.id, reason: 'descartada_por_el_jugador' }); continue; }
      if (this.#count(tenant, c.id, profile.player_id, 'impression', t - DAY) >= c.max_impressions_per_day) { skipped.push({ campaign_id: c.id, reason: 'tope_diario' }); continue; }
      const content = c.content[(opts.locale ?? 'es') as 'es'] ?? c.content.es!;
      this.track(tenant, profile.player_id, { campaign_id: c.id, type: 'impression', request_id: opts.request_id });
      return { campaign_id: c.id, placement, purpose: c.purpose, content, skipped };
    }
    return { campaign_id: null, placement, content: null, skipped };
  }

  /** Impresión, clic o descarte; idempotente por solicitud. */
  track(tenant: string, player: string, ev: { campaign_id: string; type: Interaction['type']; request_id: string }) {
    if (!['impression', 'click', 'dismiss'].includes(ev.type)) throw new DomainError('invalid_interaction', 'Tipo no válido: impression, click o dismiss.');
    if (!ev.request_id) throw new DomainError('request_id_required', 'Falta request_id para no contar dos veces.');
    this.get(tenant, ev.campaign_id);
    const k = `${tenant}::${ev.request_id}::${ev.type}`;
    if (!this.#log.has(k)) this.#log.set(k, { campaign_id: ev.campaign_id, player_id: player, type: ev.type, at: this.#clock.now().getTime(), request_id: ev.request_id });
    return { recorded: true };
  }

  stats(tenant: string) {
    const out = new Map<string, { impressions: number; players: Set<string>; clicks: number; dismisses: number }>();
    for (const [k, x] of this.#log) {
      if (!k.startsWith(`${tenant}::`)) continue;
      const s = out.get(x.campaign_id) ?? { impressions: 0, players: new Set<string>(), clicks: 0, dismisses: 0 };
      if (x.type === 'impression') { s.impressions++; s.players.add(x.player_id); } else if (x.type === 'click') s.clicks++; else s.dismisses++;
      out.set(x.campaign_id, s);
    }
    return new Map([...out].map(([id, s]) => [id, { impressions: s.impressions, unique_players: s.players.size, clicks: s.clicks, ctr: s.impressions ? s.clicks / s.impressions : null, dismisses: s.dismisses }]));
  }
}
