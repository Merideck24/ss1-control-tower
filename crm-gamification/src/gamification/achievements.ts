/**
 * Logros con niveles («Mis logros») y tarjetas compartibles.
 *
 * Logros: catálogo con condición, niveles y fecha de obtención. Se desbloquean por hitos que el CRM
 * ya conoce (retos completados, perfil completo, funciones exploradas, nivel de fidelidad).
 *
 * Tarjetas: SVG con la identidad de la marca, el logro, su insignia y el alias **solo si el jugador lo
 * autorizó**. Nunca llevan saldos, depósitos, apuestas ni datos personales. Compartir exige una acción
 * explícita del jugador; un enlace público usa un identificador opaco, es voluntario y revocable.
 * Métricas separadas: clic en compartir, descarga, visita atribuida y publicación confirmada (esta
 * última solo con evidencia del canal).
 */
import type { AuditLog } from '../audit/audit.ts';
import type { LoyaltyService } from '../loyalty/loyalty.ts';
import { DomainError, type Clock } from '../shared/util.ts';
import type { RealtimeHub } from './realtime.ts';

export type Locale = 'es' | 'en' | 'pt';
type T3 = Record<Locale, string>;
export type AchievementMetric = 'challenges_completed' | 'profile_completed' | 'features_explored' | 'loyalty_level';
export type AchievementDef = { id: string; name: T3; description: T3; icon: 'trophy' | 'compass' | 'shield' | 'crown'; metric: AchievementMetric; levels: { level: number; label: T3; threshold: number }[] };

const L = (es: string, en: string, pt: string): T3 => ({ es, en, pt });
const TIERS = [L('Bronce', 'Bronze', 'Bronze'), L('Plata', 'Silver', 'Prata'), L('Oro', 'Gold', 'Ouro')];
export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'retador', icon: 'trophy', metric: 'challenges_completed', name: L('Retador', 'Challenger', 'Desafiante'), description: L('Completa retos', 'Complete challenges', 'Complete desafios'),
    levels: [{ level: 1, label: TIERS[0], threshold: 1 }, { level: 2, label: TIERS[1], threshold: 5 }, { level: 3, label: TIERS[2], threshold: 20 }] },
  { id: 'perfil_completo', icon: 'shield', metric: 'profile_completed', name: L('Perfil completo', 'Complete profile', 'Perfil completo'), description: L('Completa tu perfil', 'Complete your profile', 'Complete seu perfil'),
    levels: [{ level: 1, label: L('Único', 'Unique', 'Único'), threshold: 1 }] },
  { id: 'explorador', icon: 'compass', metric: 'features_explored', name: L('Explorador', 'Explorer', 'Explorador'), description: L('Descubre funciones del sitio', 'Discover site features', 'Descubra recursos do site'),
    levels: [{ level: 1, label: TIERS[0], threshold: 2 }, { level: 2, label: TIERS[1], threshold: 4 }, { level: 3, label: TIERS[2], threshold: 6 }] },
  { id: 'fiel', icon: 'crown', metric: 'loyalty_level', name: L('Jugador fiel', 'Loyal player', 'Jogador fiel'), description: L('Sube de nivel en fidelidad', 'Level up in loyalty', 'Suba de nível na fidelidade'),
    levels: [{ level: 1, label: L('Plata', 'Silver', 'Prata'), threshold: 1 }, { level: 2, label: L('Oro', 'Gold', 'Ouro'), threshold: 2 }, { level: 3, label: L('Platino', 'Platinum', 'Platina'), threshold: 3 }] },
];
const LOYALTY_RANK: Record<string, number> = { Bronce: 0, Plata: 1, Oro: 2, Platino: 3 };

export type Unlock = { achievement_id: string; level: number; at: string };
export type ShareLink = { id: string; tenant_id: string; brand_id: string; player_id: string; achievement_id: string; level: number; created_at: string; revoked_at?: string };
export type ShareMetric = 'share_click' | 'download' | 'visit' | 'post_confirmed';
export type Alias = { alias: string; show_on_cards: boolean; updated_at: string };
export type PlayerAchState = { tenant_id: string; player_id: string; challenges: number; profile: boolean; features: string[]; unlocks: Unlock[]; alias: Alias | null };

/** Identidad visual por defecto de SS1 (si la marca no define la suya). */
export const SS1_TOKENS = { bg: '#062B3D', cta: '#FFD21F', icon: '#F5B700', text: '#F4F7E8', secondary: '#087A78', promo: '#FF7A1A' };

/** 16 bytes aleatorios en base64url (22 caracteres). Funciona en Node y en el navegador (demo estática). */
function opaqueId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let bin = ''; for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const ALIAS_RE = /^[\p{L}\p{N}_.-]{3,16}$/u;
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const ICONS: Record<AchievementDef['icon'], string> = {
  trophy: 'M-34-40h68v22c0 24-16 40-34 40s-34-16-34-40zM-10 22h20v16h16v14h-52v-14h16z',
  compass: 'M0-46a46 46 0 1 0 .1 0zM0-32l12 32-12 32-12-32z',
  shield: 'M0-46l38 14v26c0 26-18 44-38 52-20-8-38-26-38-52v-26z',
  crown: 'M-44 30l-8-56 28 24 24-36 24 36 28-24-8 56z',
};

export class AchievementService {
  #counters = new Map<string, { challenges: number; profile: boolean; features: Set<string> }>();
  #unlocks = new Map<string, Unlock[]>();
  #aliases = new Map<string, Alias>();
  #links = new Map<string, ShareLink>();
  #metrics = new Map<string, Record<ShareMetric, number>>(); // tenant::achievement
  #d: { clock: Clock; audit: AuditLog; loyalty: LoyaltyService; realtime: RealtimeHub; brandName: (tenant: string, brand: string) => string };
  /** Persistencia: estado de jugador, enlaces y métricas que cambiaron. */
  onChange?: (x: { players?: PlayerAchState[]; links?: ShareLink[]; metrics?: { tenant_id: string; achievement_id: string; counts: Record<ShareMetric, number> }[] }) => void;
  constructor(d: AchievementService['_deps']) { this.#d = d; }
  /** Estado durable de un jugador (contadores, desbloqueos y alias). */
  snapshot(tenant: string, player: string): PlayerAchState {
    const c = this.#c(tenant, player);
    return { tenant_id: tenant, player_id: player, challenges: c.challenges, profile: c.profile, features: [...c.features], unlocks: [...(this.#unlocks.get(`${tenant}::${player}`) ?? [])], alias: this.alias(tenant, player) };
  }
  #changed(tenant: string, player: string) { this.onChange?.({ players: [this.snapshot(tenant, player)] }); }
  restore(x: { players?: PlayerAchState[]; links?: ShareLink[]; metrics?: { tenant_id: string; achievement_id: string; counts: Record<ShareMetric, number> }[] }) {
    for (const p of x.players ?? []) {
      const k = `${p.tenant_id}::${p.player_id}`;
      this.#counters.set(k, { challenges: p.challenges, profile: p.profile, features: new Set(p.features) });
      this.#unlocks.set(k, p.unlocks);
      if (p.alias) this.#aliases.set(k, p.alias); else this.#aliases.delete(k);
    }
    for (const l of x.links ?? []) this.#links.set(l.id, l);
    for (const m of x.metrics ?? []) this.#metrics.set(`${m.tenant_id}::${m.achievement_id}`, m.counts);
  }
  declare _deps: { clock: Clock; audit: AuditLog; loyalty: LoyaltyService; realtime: RealtimeHub; brandName: (tenant: string, brand: string) => string };

  #c(tenant: string, player: string) {
    const k = `${tenant}::${player}`;
    let c = this.#counters.get(k);
    if (!c) this.#counters.set(k, (c = { challenges: 0, profile: false, features: new Set() }));
    return c;
  }
  recordChallengeCompleted(tenant: string, brand: string, player: string) { this.#c(tenant, player).challenges++; const u = this.evaluate(tenant, brand, player); this.#changed(tenant, player); return u; }
  recordActivity(tenant: string, brand: string, player: string, action: string, feature?: string) {
    const c = this.#c(tenant, player);
    if (action === 'profile_completed') c.profile = true;
    if (action === 'feature_visited' && feature) c.features.add(feature.slice(0, 40));
    const u = this.evaluate(tenant, brand, player); this.#changed(tenant, player); return u;
  }

  #value(tenant: string, brand: string, player: string, m: AchievementMetric): number {
    const c = this.#c(tenant, player);
    if (m === 'challenges_completed') return c.challenges;
    if (m === 'profile_completed') return c.profile ? 1 : 0;
    if (m === 'features_explored') return c.features.size;
    const prog = this.#d.loyalty.program(tenant, brand) ? this.#d.loyalty.progress(tenant, brand, player) : null;
    return prog ? LOYALTY_RANK[prog.level] ?? 0 : 0;
  }

  /** Desbloquea los niveles alcanzados (idempotente). Respeta la exclusión voluntaria de fidelidad. */
  evaluate(tenant: string, brand: string, player: string): Unlock[] {
    if (this.#d.loyalty.isOptedOut(tenant, player)) return [];
    const k = `${tenant}::${player}`;
    const have = this.#unlocks.get(k) ?? [];
    const fresh: Unlock[] = [];
    for (const a of ACHIEVEMENTS) {
      const v = this.#value(tenant, brand, player, a.metric);
      for (const lv of a.levels) {
        if (v >= lv.threshold && !have.some((u) => u.achievement_id === a.id && u.level === lv.level)) {
          const u = { achievement_id: a.id, level: lv.level, at: this.#d.clock.now().toISOString() };
          have.push(u); fresh.push(u);
          this.#d.audit.record(tenant, 'system', 'achievement.unlocked', player, { achievement: a.id, level: lv.level });
          this.#d.realtime.publish(tenant, player, 'achievement.unlocked', { achievement_id: a.id, level: lv.level, name: a.name.es, level_label: lv.label.es });
        }
      }
    }
    this.#unlocks.set(k, have);
    if (fresh.length) this.#changed(tenant, player);
    return fresh;
  }

  /** «Mis logros»: obtenidos (con fecha) y por obtener (con avance), en el idioma del jugador. */
  mine(tenant: string, brand: string, player: string, locale: Locale = 'es') {
    const have = this.#unlocks.get(`${tenant}::${player}`) ?? [];
    return ACHIEVEMENTS.map((a) => {
      const value = this.#value(tenant, brand, player, a.metric);
      const got = have.filter((u) => u.achievement_id === a.id).sort((x, y) => y.level - x.level)[0];
      const next = a.levels.find((l) => l.threshold > value && !(got && l.level <= got.level));
      return {
        id: a.id, icon: a.icon, name: a.name[locale], description: a.description[locale], value,
        level: got ? { level: got.level, label: a.levels.find((l) => l.level === got.level)!.label[locale], at: got.at } : null,
        next: next ? { level: next.level, label: next.label[locale], threshold: next.threshold } : null,
        levels: a.levels.map((l) => ({ level: l.level, label: l.label[locale], threshold: l.threshold, unlocked: have.some((u) => u.achievement_id === a.id && u.level === l.level) })),
      };
    });
  }
  unlocked(tenant: string, player: string) { return [...(this.#unlocks.get(`${tenant}::${player}`) ?? [])]; }

  // ───────── alias ─────────
  setAlias(tenant: string, player: string, alias: string, show: boolean): Alias {
    const a = alias.trim();
    if (!ALIAS_RE.test(a)) throw new DomainError('invalid_alias', 'El alias debe tener de 3 a 16 letras, números, punto, guion o guion bajo.');
    if (/@|\d{7,}/.test(a) || a.toLowerCase() === player.toLowerCase()) throw new DomainError('invalid_alias', 'El alias no puede ser tu correo, tu teléfono ni tu identificador.');
    const v = { alias: a, show_on_cards: show, updated_at: this.#d.clock.now().toISOString() };
    this.#aliases.set(`${tenant}::${player}`, v);
    this.#d.audit.record(tenant, player, 'player.alias_set', player, { show_on_cards: show });
    this.#changed(tenant, player);
    return v;
  }
  alias(tenant: string, player: string) { return this.#aliases.get(`${tenant}::${player}`) ?? null; }

  // ───────── tarjeta ─────────
  /** Tarjeta 1200×630 (formato de vista previa en redes). Requiere el logro obtenido. */
  card(tenant: string, brand: string, player: string, achievementId: string, locale: Locale = 'es') {
    const a = ACHIEVEMENTS.find((x) => x.id === achievementId);
    const u = (this.#unlocks.get(`${tenant}::${player}`) ?? []).filter((x) => x.achievement_id === achievementId).sort((x, y) => y.level - x.level)[0];
    if (!a || !u) throw new DomainError('not_unlocked', 'Ese logro aún no está obtenido: no hay tarjeta para compartir.');
    return this.#render(tenant, brand, player, a, u, locale);
  }

  #render(tenant: string, brand: string, player: string, a: AchievementDef, u: Unlock, locale: Locale) {
    const t = SS1_TOKENS;
    const lv = a.levels.find((l) => l.level === u.level)!.label[locale];
    const al = this.alias(tenant, player);
    const who = al?.show_on_cards ? al.alias : ({ es: 'Un jugador', en: 'A player', pt: 'Um jogador' } as T3)[locale];
    const brandName = this.#d.brandName(tenant, brand);
    const date = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : locale === 'pt' ? 'pt-BR' : 'es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(u.at));
    const headline = ({ es: 'desbloqueó un logro', en: 'unlocked an achievement', pt: 'desbloqueou uma conquista' } as T3)[locale];
    const text = `${who} ${headline} en ${brandName}: ${a.name[locale]} · ${lv}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${xml(text)}">
<rect width="1200" height="630" fill="${t.bg}"/>
<rect x="0" y="560" width="1200" height="70" fill="${t.secondary}"/>
<g transform="translate(300 300)"><circle r="170" fill="none" stroke="${t.icon}" stroke-width="10"/><circle r="150" fill="${t.secondary}" opacity=".35"/><path d="${ICONS[a.icon]}" transform="scale(2.2)" fill="${t.icon}"/></g>
<text x="540" y="200" fill="${t.text}" font-family="Arial, Helvetica, sans-serif" font-size="34">${xml(who)} ${xml(headline)}</text>
<text x="540" y="290" fill="${t.cta}" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="72" font-weight="700">${xml(a.name[locale])}</text>
<rect x="540" y="325" rx="26" width="${60 + lv.length * 26}" height="56" fill="${t.promo}"/>
<text x="570" y="364" fill="${t.bg}" font-family="Arial, Helvetica, sans-serif" font-size="32" font-weight="700">${xml(lv)}</text>
<text x="540" y="450" fill="${t.text}" font-family="Arial, Helvetica, sans-serif" font-size="28" opacity=".85">${xml(a.description[locale])} · ${xml(date)}</text>
<text x="40" y="606" fill="${t.text}" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700">${xml(brandName)}</text>
<text x="1160" y="606" fill="${t.text}" font-family="Arial, Helvetica, sans-serif" font-size="22" text-anchor="end" opacity=".85">Juega con responsabilidad · +18</text>
</svg>`;
    return { svg, text, alt: text, achievement_id: a.id, level: u.level, alias_shown: !!al?.show_on_cards };
  }

  // ───────── enlaces públicos ─────────
  createLink(tenant: string, brand: string, player: string, achievementId: string): ShareLink {
    const u = (this.#unlocks.get(`${tenant}::${player}`) ?? []).filter((x) => x.achievement_id === achievementId).sort((x, y) => y.level - x.level)[0];
    if (!u) throw new DomainError('not_unlocked', 'Ese logro aún no está obtenido.');
    const link: ShareLink = { id: opaqueId(), tenant_id: tenant, brand_id: brand, player_id: player, achievement_id: achievementId, level: u.level, created_at: this.#d.clock.now().toISOString() };
    this.#links.set(link.id, link);
    this.#d.audit.record(tenant, player, 'share.link_created', player, { achievement: achievementId, link: link.id });
    this.onChange?.({ links: [link] });
    return link;
  }
  revokeLink(tenant: string, player: string, id: string): ShareLink {
    const l = this.#links.get(id);
    if (!l || l.tenant_id !== tenant || l.player_id !== player) throw new DomainError('not_found', 'Enlace inexistente.');
    if (!l.revoked_at) { l.revoked_at = this.#d.clock.now().toISOString(); this.#d.audit.record(tenant, player, 'share.link_revoked', player, { link: id }); this.onChange?.({ links: [l] }); }
    return l;
  }
  links(tenant: string, player: string) { return [...this.#links.values()].filter((l) => l.tenant_id === tenant && l.player_id === player); }
  /** Vista pública de un enlace: sin sesión, solo si no fue revocado. Registra la visita atribuida. */
  publicCard(id: string, locale: Locale = 'es') {
    const l = this.#links.get(id);
    if (!l || l.revoked_at) return null;
    const a = ACHIEVEMENTS.find((x) => x.id === l.achievement_id)!;
    this.track(l.tenant_id, l.player_id, 'visit', l.achievement_id);
    return this.#render(l.tenant_id, l.brand_id, l.player_id, a, { achievement_id: l.achievement_id, level: l.level, at: l.created_at }, locale);
  }

  // ───────── métricas ─────────
  track(tenant: string, _player: string, type: ShareMetric, achievementId: string, evidence?: { channel: string; post_ref: string }) {
    if (!ACHIEVEMENTS.some((a) => a.id === achievementId)) throw new DomainError('not_found', 'Logro inexistente.');
    if (type === 'post_confirmed' && !(evidence?.channel && evidence?.post_ref)) throw new DomainError('evidence_required', 'Una publicación solo se confirma con evidencia del canal (id o enlace de la publicación).');
    const k = `${tenant}::${achievementId}`;
    const m = this.#metrics.get(k) ?? { share_click: 0, download: 0, visit: 0, post_confirmed: 0 };
    m[type]++;
    this.#metrics.set(k, m);
    this.onChange?.({ metrics: [{ tenant_id: tenant, achievement_id: achievementId, counts: { ...m } }] });
  }
  shareMetrics(tenant: string) {
    return ACHIEVEMENTS.map((a) => ({ achievement_id: a.id, name: a.name.es, ...(this.#metrics.get(`${tenant}::${a.id}`) ?? { share_click: 0, download: 0, visit: 0, post_confirmed: 0 }),
      links_active: [...this.#links.values()].filter((l) => l.tenant_id === tenant && l.achievement_id === a.id && !l.revoked_at).length,
      unlocked_players: [...this.#unlocks].filter(([k, us]) => k.startsWith(`${tenant}::`) && us.some((u) => u.achievement_id === a.id)).length }));
  }
}
