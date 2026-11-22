import type { PlayerProfile } from '../profile/projection.ts';
import { DomainError, sha256 } from '../shared/util.ts';

/** Árbol de reglas AND/OR sobre atributos y eventos (CRM-02). */
export type Condition =
  | { field: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; value: string | number | boolean }
  | { field: string; op: 'in'; value: (string | number)[] }
  | { field: string; op: 'exists'; value: boolean }
  | { event: string; op: 'occurred_within_days' | 'not_occurred_within_days'; value: number };
export type RuleNode = { and: RuleNode[] } | { or: RuleNode[] } | { not: RuleNode } | Condition;

export type SegmentDefinition = {
  id: string;
  tenant_id: string;
  name: string;
  version: number;
  rules: RuleNode;
  exclusions?: RuleNode;
};

/** Campos permitidos (catálogo). Evita acceso arbitrario a la proyección. */
const FIELDS: Record<string, (p: PlayerProfile) => unknown> = {
  'kyc': (p) => p.kyc?.value,
  'rg': (p) => p.rg?.value,
  'country': (p) => p.country?.value,
  'locale': (p) => p.locale?.value,
  'brand_id': (p) => p.brand_id,
  'stats.deposit_count': (p) => p.stats.deposit_count,
  'stats.deposits_minor': (p) => p.stats.deposits_minor,
  'stats.bets_count': (p) => p.stats.bets_count,
  'stats.stake_minor': (p) => p.stats.stake_minor,
  'consent.marketing.email': (p) => p.consents['marketing:email']?.value ?? false,
  'consent.marketing.inapp': (p) => p.consents['marketing:inapp']?.value ?? false,
  'consent.marketing.webpush': (p) => p.consents['marketing:webpush']?.value ?? false,
  'rewards.active_count': (p) => p.rewards.length,
};
export const SEGMENT_FIELDS = Object.keys(FIELDS);

export function evaluate(node: RuleNode, p: PlayerProfile, asOf: Date): boolean {
  if ('and' in node) return node.and.every((n) => evaluate(n, p, asOf));
  if ('or' in node) return node.or.some((n) => evaluate(n, p, asOf));
  if ('not' in node) return !evaluate(node.not, p, asOf);
  if ('event' in node) {
    const since = asOf.getTime() - node.value * 86_400_000;
    const hit = p.timeline.some((t) => t.event_type === node.event && Date.parse(t.occurred_at) >= since && Date.parse(t.occurred_at) <= asOf.getTime());
    return node.op === 'occurred_within_days' ? hit : !hit;
  }
  const getter = FIELDS[node.field];
  if (!getter) throw new DomainError('unknown_field', node.field);
  const v = getter(p) as string | number | boolean | undefined;
  const n = node.value as string | number;
  switch (node.op) {
    case 'eq': return v === node.value;
    case 'neq': return v !== node.value;
    case 'gt': return v !== undefined && (v as string | number) > n;
    case 'gte': return v !== undefined && (v as string | number) >= n;
    case 'lt': return v !== undefined && (v as string | number) < n;
    case 'lte': return v !== undefined && (v as string | number) <= n;
    case 'in': return (node.value as unknown[]).includes(v);
    case 'exists': return (v !== undefined && v !== null) === node.value;
  }
}

export type SegmentResult = { segment_id: string; version: number; as_of: string; snapshot_hash: string; members: string[]; excluded: string[]; universe: number };

/**
 * Evalúa sobre un snapshot inmutable: mismo snapshot + misma versión ⇒ mismo resultado.
 * La elegibilidad se vuelve a validar al ejecutar (ver JourneyRuntime/PolicyEngine).
 */
export function runSegment(def: SegmentDefinition, snapshot: readonly PlayerProfile[], asOf: Date): SegmentResult {
  const scoped = snapshot.filter((p) => p.tenant_id === def.tenant_id).slice().sort((a, b) => a.player_id.localeCompare(b.player_id));
  const members: string[] = [];
  const excluded: string[] = [];
  for (const p of scoped) {
    if (!evaluate(def.rules, p, asOf)) continue;
    if (def.exclusions && evaluate(def.exclusions, p, asOf)) excluded.push(p.player_id);
    else members.push(p.player_id);
  }
  const snapshot_hash = sha256(JSON.stringify(scoped.map((p) => [p.player_id, p.timeline.length, p.timeline.at(-1)?.event_id])));
  return { segment_id: def.id, version: def.version, as_of: asOf.toISOString(), snapshot_hash, members, excluded, universe: scoped.length };
}

export function validateRules(node: RuleNode): string[] {
  const errs: string[] = [];
  const walk = (n: RuleNode) => {
    if ('and' in n) n.and.forEach(walk);
    else if ('or' in n) n.or.forEach(walk);
    else if ('not' in n) walk(n.not);
    else if ('field' in n && !FIELDS[n.field]) errs.push(`unknown_field:${n.field}`);
  };
  walk(node);
  return errs;
}
