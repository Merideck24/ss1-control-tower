import type { AuditLog } from '../audit/audit.ts';
import type { ChannelHub, Locale, Template } from '../channels/channels.ts';
import type { Purpose } from '../domain/events.ts';
import { DomainError, sha256, type Clock } from '../shared/util.ts';
import { moderate, MODERATION_RULES, type DraftText, type ModerationIssue } from './moderation.ts';

/**
 * E6 · Estudio de contenido: la IA solo escribe borradores. Todo borrador pasa por
 * moderación determinista, puede editarlo una persona, y para convertirse en plantilla
 * requiere aprobación de otra persona. Nada generado se envía sin ese paso.
 */
export type ContentBrief = { key: string; goal: string; audience?: string; tone?: 'cercano' | 'formal' | 'entusiasta'; purpose: Purpose; locales: Locale[]; vars: string[]; include_sms?: boolean };
export type WriterResult = { drafts: Partial<Record<Locale, DraftText>>; source: 'claude' | 'base'; model?: string; note?: string };
/** Escritor de borradores (Claude en el servidor; texto base sin IA en la demo estática). */
export type WriterFn = (brief: ContentBrief) => Promise<WriterResult>;

export type ContentDraft = {
  id: string; tenant_id: string; brief: ContentBrief; texts: Partial<Record<Locale, DraftText>>;
  source: WriterResult['source']; model?: string; brief_hash: string; moderation: ModerationIssue[]; moderation_version: string;
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected'; created_by: string; edited_by?: string; approved_by?: string; reject_reason?: string; created_at: string; updated_at: string;
};

const VAR_RE = /^\w{1,30}$/;
export function validateBrief(b: Partial<ContentBrief>): string[] {
  const errs: string[] = [];
  if (!b.key || !/^[a-z][a-z0-9_]{2,40}$/.test(b.key)) errs.push('La clave de plantilla va en minúsculas con guiones bajos (3–41 caracteres).');
  if (!b.goal || b.goal.trim().length < 10 || b.goal.length > 500) errs.push('Describe el objetivo del mensaje (10–500 caracteres).');
  if (b.purpose !== 'marketing' && b.purpose !== 'service') errs.push('El propósito debe ser marketing o servicio.');
  if (!Array.isArray(b.locales) || !b.locales.length || b.locales.some((l) => !['es', 'en', 'pt'].includes(l))) errs.push('Elige al menos un idioma: es, en o pt.');
  if (!Array.isArray(b.vars) || b.vars.some((v) => !VAR_RE.test(v))) errs.push('Las variables son nombres simples (letras, números y guion bajo).');
  return errs;
}

/** Texto base sin IA: deja claro que es un punto de partida para editar. */
export const baseWriter: WriterFn = async (b) => {
  const footer = b.purpose === 'marketing' ? { es: ' Juega con responsabilidad. +18', en: ' Play responsibly. 18+', pt: ' Jogue com responsabilidade. +18' } : { es: '', en: '', pt: '' };
  const v = b.vars.length ? ` ${b.vars.map((x) => `{{${x}}}`).join(' ')}` : '';
  const goal = b.goal.trim().replace(/\.$/, '');
  const drafts: Partial<Record<Locale, DraftText>> = {};
  for (const l of b.locales) {
    const subject = { es: 'Novedades para ti', en: 'News for you', pt: 'Novidades para você' }[l];
    const body = { es: `${goal}.${v}`, en: `${goal}.${v}`, pt: `${goal}.${v}` }[l] + footer[l];
    drafts[l] = { subject, body, ...(b.include_sms ? { sms: `RumbaWin: ${goal}.`.slice(0, 120) + (b.purpose === 'marketing' ? ' +18' : '') } : {}) };
  }
  return { drafts, source: 'base', note: 'Texto base sin IA (IA no configurada en este entorno). Edítalo antes de enviarlo.' };
};

export class ContentStudio {
  #drafts = new Map<string, ContentDraft>();
  #audit: AuditLog; #clock: Clock; #channels: ChannelHub;
  constructor(deps: { audit: AuditLog; clock: Clock; channels: ChannelHub }) { this.#audit = deps.audit; this.#clock = deps.clock; this.#channels = deps.channels; }

  drafts(tenant: string) { return [...this.#drafts.values()].filter((d) => d.tenant_id === tenant).sort((a, b) => b.updated_at.localeCompare(a.updated_at)); }
  get(tenant: string, id: string) { const d = this.#drafts.get(id); if (!d || d.tenant_id !== tenant) throw new DomainError('not_found', `No existe el borrador ${id}.`); return d; }
  #moderate(d: Pick<ContentDraft, 'texts' | 'brief'>) { return moderate(d.texts, { purpose: d.brief.purpose, allowedVars: d.brief.vars }); }

  async generate(actor: { id: string; tenant_id: string }, brief: ContentBrief, writer: WriterFn): Promise<ContentDraft> {
    const errs = validateBrief(brief);
    if (errs.length) throw new DomainError('invalid_brief', errs.join(' '));
    if (this.#channels.template(actor.tenant_id, brief.key)) throw new DomainError('template_exists', `Ya existe la plantilla «${brief.key}»: usa otra clave.`);
    const out = await writer(brief);
    const missing = brief.locales.filter((l) => !out.drafts[l]?.body);
    if (missing.length) throw new DomainError('writer_incomplete', `El escritor no devolvió texto para: ${missing.join(', ')}.`);
    const now = this.#clock.now().toISOString();
    const d: ContentDraft = { id: `cd_${sha256(`${actor.tenant_id}:${brief.key}:${now}:${this.#drafts.size}`).slice(0, 10)}`, tenant_id: actor.tenant_id, brief: structuredClone(brief), texts: out.drafts, source: out.source, ...(out.model ? { model: out.model } : {}),
      brief_hash: sha256(JSON.stringify(brief)).slice(0, 16), moderation: [], moderation_version: MODERATION_RULES.version, status: 'draft', created_by: actor.id, created_at: now, updated_at: now };
    d.moderation = this.#moderate(d);
    this.#drafts.set(d.id, d);
    this.#audit.record(actor.tenant_id, actor.id, 'content.generated', d.id, { key: brief.key, source: d.source, model: d.model ?? null, brief_hash: d.brief_hash, blocking: d.moderation.filter((i) => i.severity === 'block').length });
    return d;
  }

  edit(actor: { id: string; tenant_id: string }, id: string, texts: Partial<Record<Locale, DraftText>>): ContentDraft {
    const d = this.get(actor.tenant_id, id);
    if (d.status !== 'draft' && d.status !== 'rejected') throw new DomainError('invalid_state', 'Solo se editan borradores o rechazados.');
    for (const l of Object.keys(texts)) if (!d.brief.locales.includes(l as Locale)) throw new DomainError('invalid_locale', `El idioma ${l} no está en el pedido.`);
    d.texts = { ...d.texts, ...texts }; d.edited_by = actor.id; d.status = 'draft'; d.updated_at = this.#clock.now().toISOString();
    d.moderation = this.#moderate(d);
    this.#audit.record(actor.tenant_id, actor.id, 'content.edited', id, { blocking: d.moderation.filter((i) => i.severity === 'block').length });
    return d;
  }

  submit(actor: { id: string; tenant_id: string }, id: string): ContentDraft {
    const d = this.get(actor.tenant_id, id);
    if (d.status !== 'draft') throw new DomainError('invalid_state', 'Solo se envían borradores.');
    d.moderation = this.#moderate(d);
    const blocking = d.moderation.filter((i) => i.severity === 'block');
    if (blocking.length) throw new DomainError('moderation_blocked', `Corrige antes de enviar: ${[...new Set(blocking.map((i) => i.message))].join(' ')}`);
    d.status = 'pending_approval'; d.updated_at = this.#clock.now().toISOString();
    this.#audit.record(actor.tenant_id, actor.id, 'content.submitted', id, {});
    return d;
  }

  decide(actor: { id: string; tenant_id: string }, id: string, approve: boolean, reason = ''): ContentDraft {
    const d = this.get(actor.tenant_id, id);
    if (d.status !== 'pending_approval') throw new DomainError('invalid_state', 'Solo se deciden borradores pendientes.');
    if (actor.id === d.created_by || actor.id === d.edited_by) throw new DomainError('segregation_of_duties', 'Quien generó o editó el texto no puede aprobarlo.');
    if (!approve) {
      if (reason.trim().length < 5) throw new DomainError('reason_required', 'Indica por qué se rechaza (mínimo 5 caracteres).');
      d.status = 'rejected'; d.reject_reason = reason.trim();
    } else {
      const t: Template = { key: d.brief.key, category: d.brief.purpose === 'service' ? 'transactional' : 'promotional', purpose: d.brief.purpose,
        content: Object.fromEntries(Object.entries(d.texts).map(([l, x]) => [l, { subject: x!.subject, body: x!.body }])),
        ...(Object.values(d.texts).some((x) => x?.sms) ? { channels: { sms: Object.fromEntries(Object.entries(d.texts).filter(([, x]) => x?.sms).map(([l, x]) => [l, x!.sms!])) } } : {}) };
      if (this.#channels.template(d.tenant_id, t.key)) throw new DomainError('template_exists', `Ya existe la plantilla «${t.key}».`);
      this.#channels.addTemplate(d.tenant_id, t);
      d.status = 'approved'; d.approved_by = actor.id;
    }
    d.updated_at = this.#clock.now().toISOString();
    this.#audit.record(actor.tenant_id, actor.id, approve ? 'content.approved' : 'content.rejected', id, { key: d.brief.key, source: d.source, model: d.model ?? null, ...(approve ? {} : { reason: d.reject_reason }) });
    return d;
  }
}
