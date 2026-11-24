/**
 * J3 · Interfaz de bus de eventos (Kafka / RabbitMQ / Pub/Sub).
 * El CRM publica y consume a través de esta interfaz; el adaptador real se conecta
 * cuando SS1 defina el broker (bloqueado: requiere infraestructura y credenciales).
 * Contrato: entrega al menos una vez y orden por clave de partición (tenant::jugador);
 * los consumidores deben ser idempotentes (la ingesta ya deduplica por event_id).
 */
export type BusMessage = { topic: string; key?: string; value: unknown; at: string };
export interface EventBus {
  publish(topic: string, value: unknown, key?: string): void;
  subscribe(topic: string, handler: (m: BusMessage) => void): () => void;
}

/** Bus en memoria: pruebas, demo y modo de un solo proceso. Conserva los últimos mensajes por tema. */
export class InMemoryBus implements EventBus {
  #handlers = new Map<string, Set<(m: BusMessage) => void>>();
  #log = new Map<string, BusMessage[]>();
  retain = 200;
  publish(topic: string, value: unknown, key?: string) {
    const m: BusMessage = { topic, value, at: new Date().toISOString(), ...(key ? { key } : {}) };
    const l = this.#log.get(topic) ?? []; l.push(m); if (l.length > this.retain) l.splice(0, l.length - this.retain); this.#log.set(topic, l);
    for (const h of this.#handlers.get(topic) ?? []) h(m);
  }
  subscribe(topic: string, handler: (m: BusMessage) => void) {
    const s = this.#handlers.get(topic) ?? new Set(); s.add(handler); this.#handlers.set(topic, s);
    return () => { s.delete(handler); };
  }
  recent(topic: string) { return [...(this.#log.get(topic) ?? [])]; }
  topics() { return [...this.#log.keys()]; }
}
