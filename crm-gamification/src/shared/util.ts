import { createHash, randomUUID } from 'node:crypto';

export type Clock = { now(): Date };
export const systemClock: Clock = { now: () => new Date() };

/** Manual clock for deterministic tests and simulations. */
export class ManualClock implements Clock {
  #t: number;
  constructor(iso = '2026-11-15T12:00:00Z') { this.#t = Date.parse(iso); }
  now(): Date { return new Date(this.#t); }
  advance(ms: number): void { this.#t += ms; }
  set(iso: string): void { this.#t = Date.parse(iso); }
}

/** Reloj real con desplazamiento (demo: permite adelantar el tiempo para vencer esperas). */
export class OffsetClock implements Clock {
  #offset = 0;
  now(): Date { return new Date(Date.now() + this.#offset); }
  advance(ms: number): void { this.#offset += ms; }
}

export const uuid = (): string => randomUUID();

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable bucket in [0, 1) derived from a key — used for control groups. */
export function stableBucket(key: string): number {
  return parseInt(sha256(key).slice(0, 8), 16) / 0x1_0000_0000;
}

export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
