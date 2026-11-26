-- Fase 2 · incremento 3: instancias de recorridos, recibos de entrega y reprocesos durables.
-- Se aplica sobre 001_init.sql sin perder datos: solo agrega columnas, amplía restricciones e índices.

-- ───────────── Auditoría: una cadena por escritor ─────────────
-- La web y el worker escriben a la vez; cada proceso lleva su propia cadena encadenada por hash
-- (writer = 'web', 'worker' o el id de la réplica) y cada una se verifica por separado.
-- ADD COLUMN con DEFAULT no dispara el trigger de solo-anexar (no es un UPDATE de filas).
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS writer text NOT NULL DEFAULT 'web';
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_pkey;
ALTER TABLE audit_log ADD PRIMARY KEY (writer, seq);

-- ───────────── Versiones de recorridos ─────────────
-- «closed» (cierre definitivo, Fase 1) no estaba en la restricción original.
ALTER TABLE journey_versions DROP CONSTRAINT IF EXISTS journey_versions_status_check;
ALTER TABLE journey_versions ADD CONSTRAINT journey_versions_status_check
  CHECK (status IN ('draft','pending_approval','approved','published','paused','archived','closed'));
CREATE INDEX IF NOT EXISTS journey_versions_updated ON journey_versions (updated_at);

-- ───────────── Instancias ─────────────
ALTER TABLE journey_instances
  ADD COLUMN IF NOT EXISTS trigger_payload jsonb,
  ADD COLUMN IF NOT EXISTS deferred_node   text,
  ADD COLUMN IF NOT EXISTS updated_at      timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS journey_instances_journey ON journey_instances (tenant_id, journey_id, version, status);
CREATE INDEX IF NOT EXISTS journey_instances_updated ON journey_instances (updated_at);

-- ───────────── Recibos de entrega ─────────────
-- Estados según el contrato del canal: requested (escrito antes del efecto), accepted, delivered,
-- failed, uncertain (sin respuesta: se concilia antes de reenviar), suppressed, deferred.
ALTER TABLE delivery_receipts DROP CONSTRAINT IF EXISTS delivery_receipts_status_check;
ALTER TABLE delivery_receipts ADD CONSTRAINT delivery_receipts_status_check
  CHECK (status IN ('requested','accepted','delivered','failed','uncertain','suppressed','deferred'));
ALTER TABLE delivery_receipts
  ADD COLUMN IF NOT EXISTS address          text,
  ADD COLUMN IF NOT EXISTS vars             jsonb,
  ADD COLUMN IF NOT EXISTS rendered         jsonb,
  ADD COLUMN IF NOT EXISTS journey_id       text,
  ADD COLUMN IF NOT EXISTS journey_version  int,
  ADD COLUMN IF NOT EXISTS instance_id      text,
  ADD COLUMN IF NOT EXISTS node_id          text,
  ADD COLUMN IF NOT EXISTS purpose          text CHECK (purpose IS NULL OR purpose IN ('service','marketing')),
  ADD COLUMN IF NOT EXISTS trigger_event_id text,
  ADD COLUMN IF NOT EXISTS provider_at      timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now(),
  -- bloqueo de reproceso: una sola solicitud a la vez por falla, con vencimiento
  ADD COLUMN IF NOT EXISTS reprocess_lock_by text,
  ADD COLUMN IF NOT EXISTS reprocess_lock_at timestamptz;
-- cola de fallas: abiertas por tenant y fecha
CREATE INDEX IF NOT EXISTS delivery_receipts_open ON delivery_receipts (tenant_id, at DESC) WHERE status IN ('failed','uncertain','requested');
CREATE INDEX IF NOT EXISTS delivery_receipts_journey ON delivery_receipts (tenant_id, journey_id, journey_version);
CREATE INDEX IF NOT EXISTS delivery_receipts_instance ON delivery_receipts (instance_id);
CREATE INDEX IF NOT EXISTS delivery_receipts_updated ON delivery_receipts (updated_at);

-- ───────────── Historial de reprocesos (solo-anexar) ─────────────
CREATE TABLE IF NOT EXISTS reprocess_attempts (
  id              bigserial PRIMARY KEY,
  tenant_id       text NOT NULL,
  idempotency_key text NOT NULL REFERENCES delivery_receipts (idempotency_key),
  at              timestamptz NOT NULL,
  actor           text NOT NULL,
  reason          text NOT NULL,
  outcome         text NOT NULL,
  detail          text NOT NULL,
  original_reason text,
  original_status text
);
CREATE INDEX IF NOT EXISTS reprocess_attempts_key ON reprocess_attempts (tenant_id, idempotency_key, at);

ALTER TABLE reprocess_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reprocess_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON reprocess_attempts;
CREATE POLICY tenant_isolation ON reprocess_attempts
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
DROP TRIGGER IF EXISTS reprocess_attempts_append_only ON reprocess_attempts;
CREATE TRIGGER reprocess_attempts_append_only BEFORE UPDATE OR DELETE ON reprocess_attempts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
GRANT SELECT, INSERT ON reprocess_attempts TO crm_app;
GRANT USAGE ON SEQUENCE reprocess_attempts_id_seq TO crm_app;
