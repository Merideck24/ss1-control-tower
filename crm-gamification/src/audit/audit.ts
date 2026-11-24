import type { Clock } from '../shared/util.ts';
import { sha256 } from '../shared/util.ts';

export type AuditEntry = {
  seq: number;
  at: string;
  tenant_id: string;
  actor: string;
  action: string;
  subject: string;
  details: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

const SENSITIVE = /email|phone|token|secret|password|otp|link/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) && typeof v === 'string' ? '[REDACTED]' : redact(v)]),
    );
  }
  return value;
}

/** Append-only, hash-chained audit log (CRM-08). Details are redacted on write. */
export class AuditLog {
  #entries: AuditEntry[] = [];
  #clock: Clock;
  /** Oyentes de cada registro (p. ej. webhooks salientes). */
  listeners: ((e: AuditEntry) => void)[] = [];
  #seq = 0;
  #lastHash = 'genesis';
  constructor(clock: Clock) { this.#clock = clock; }
  /** Continúa la cadena persistida (al arrancar con base de datos). */
  resume(lastSeq: number, lastHash: string) { if (this.#entries.length) throw new Error('resume() solo antes del primer registro'); this.#seq = lastSeq; this.#lastHash = lastHash; }

  record(tenant_id: string, actor: string, action: string, subject: string, details: Record<string, unknown> = {}): AuditEntry {
    const prev_hash = this.#lastHash;
    const base = { seq: ++this.#seq, at: this.#clock.now().toISOString(), tenant_id, actor, action, subject, details: redact(details) as Record<string, unknown>, prev_hash };
    const entry = { ...base, hash: sha256(JSON.stringify(base)) };
    this.#entries.push(entry);
    this.#lastHash = entry.hash;
    for (const l of this.listeners) l(entry);
    return entry;
  }

  list(tenant_id: string, filter?: { subject?: string; action?: string }): AuditEntry[] {
    return this.#entries.filter((e) => e.tenant_id === tenant_id && (!filter?.subject || e.subject === filter.subject) && (!filter?.action || e.action === filter.action));
  }

  verifyChain(): boolean {
    let prev = this.#entries[0]?.prev_hash ?? 'genesis'; // tras resume() la cadena en memoria empieza donde quedó la persistida
    for (const e of this.#entries) {
      const { hash, ...base } = e;
      if (e.prev_hash !== prev || sha256(JSON.stringify(base)) !== hash) return false;
      prev = hash;
    }
    return true;
  }
}
