-- SS1 CRM y Gamificación · esquema inicial (PostgreSQL 15+)
-- Principios:
--  · Multi-tenant con Row Level Security: la app se conecta con el rol crm_app y fija
--    app.tenant_id por transacción; ninguna consulta ve filas de otro tenant.
--  · Eventos y auditoría son solo-anexar (triggers impiden UPDATE/DELETE).
--  · Lo que el código garantiza en memoria lo garantiza también la base: claves de
--    idempotencia únicas, presupuesto y stock que no bajan de cero, saldos no negativos.
--  · Montos en unidades mínimas (bigint) con moneda ISO; tiempos en timestamptz (UTC).

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id   text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Ingesta (fuente de verdad: registro de eventos) ─────────────
CREATE TABLE events (
  seq            bigserial,
  tenant_id      text NOT NULL,
  event_id       text NOT NULL,
  event_type     text NOT NULL,
  schema_version int  NOT NULL,
  brand_id       text NOT NULL,
  player_id      text NOT NULL DEFAULT '',
  occurred_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  source         text NOT NULL,
  correlation_id text NOT NULL,
  payload        jsonb NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);
CREATE UNIQUE INDEX events_seq ON events (seq);
CREATE INDEX events_tenant_seq ON events (tenant_id, seq);
CREATE INDEX events_player ON events (tenant_id, player_id, occurred_at);
CREATE INDEX events_type ON events (tenant_id, event_type, occurred_at);

CREATE TABLE dead_letters (
  id         bigserial PRIMARY KEY,
  tenant_id  text,
  reason     text NOT NULL,
  raw        jsonb NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

-- Proyección materializada del perfil (se puede reconstruir desde events)
CREATE TABLE player_profiles (
  tenant_id  text NOT NULL,
  player_id  text NOT NULL,
  brand_id   text NOT NULL,
  profile    jsonb NOT NULL,
  version    bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, player_id)
);
CREATE INDEX player_profiles_brand ON player_profiles (tenant_id, brand_id);

-- ───────────── Auditoría encadenada ─────────────
CREATE TABLE audit_log (
  seq        bigint PRIMARY KEY,
  tenant_id  text NOT NULL,
  at         timestamptz NOT NULL,
  actor      text NOT NULL,
  action     text NOT NULL,
  subject    text NOT NULL,
  details    json  NOT NULL,  -- json (no jsonb): conserva el orden de claves del que depende el hash
  prev_hash  text NOT NULL,
  hash       text NOT NULL UNIQUE
);
CREATE INDEX audit_tenant ON audit_log (tenant_id, seq);
CREATE INDEX audit_action ON audit_log (tenant_id, action);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% es solo-anexar: no se permite %', TG_TABLE_NAME, TG_OP; END $$;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────── Políticas por mercado (versionadas, con aprobación) ─────────────
CREATE TABLE market_policies (
  tenant_id   text NOT NULL,
  brand_id    text NOT NULL,
  market      char(2) NOT NULL,
  version     text NOT NULL,
  policy      jsonb NOT NULL,
  approved_by text,
  approved_at timestamptz,
  active      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, brand_id, market, version)
);
CREATE UNIQUE INDEX market_policies_one_active ON market_policies (tenant_id, brand_id, market) WHERE active;

CREATE TABLE policy_proposals (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  brand_id      text NOT NULL,
  market        char(2) NOT NULL,
  base_version  text,
  proposed      jsonb NOT NULL,
  changes       jsonb NOT NULL,
  justification text NOT NULL DEFAULT '',
  status        text NOT NULL CHECK (status IN ('pending','approved','rejected','superseded')),
  proposed_by   text NOT NULL,
  proposed_at   timestamptz NOT NULL,
  decided_by    text,
  decided_at    timestamptz,
  reject_reason text,
  CHECK (decided_by IS NULL OR decided_by <> proposed_by)
);

-- ───────────── Recorridos ─────────────
CREATE TABLE journey_versions (
  tenant_id          text NOT NULL,
  journey_id         text NOT NULL,
  version            int  NOT NULL,
  status             text NOT NULL CHECK (status IN ('draft','pending_approval','approved','published','paused','archived')),
  definition         jsonb NOT NULL,
  created_by         text NOT NULL,
  approved_by        text,
  approval_signature text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, journey_id, version),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);

CREATE TABLE journey_instances (
  instance_id      text PRIMARY KEY,
  tenant_id        text NOT NULL,
  player_id        text NOT NULL,
  journey_id       text NOT NULL,
  version          int  NOT NULL,
  arm              text NOT NULL CHECK (arm IN ('treatment','control')),
  status           text NOT NULL,
  current_node     text NOT NULL,
  wake_at          timestamptz,
  trigger_event_id text NOT NULL,
  correlation_id   text NOT NULL,
  trace            jsonb NOT NULL DEFAULT '[]',
  entered_at       timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, journey_id, version) REFERENCES journey_versions (tenant_id, journey_id, version)
);
CREATE INDEX journey_instances_due ON journey_instances (wake_at) WHERE status = 'waiting';
CREATE INDEX journey_instances_player ON journey_instances (tenant_id, player_id);

CREATE TABLE split_assignments (
  tenant_id    text NOT NULL,
  journey_id   text NOT NULL,
  node_id      text NOT NULL,
  player_id    text NOT NULL,
  variant      text NOT NULL,
  assigned_at  timestamptz NOT NULL,
  converted_at timestamptz,
  allocation   jsonb NOT NULL,
  PRIMARY KEY (tenant_id, journey_id, node_id, player_id)
);

-- ───────────── Canales y mensajes ─────────────
CREATE TABLE templates (
  tenant_id text NOT NULL,
  key       text NOT NULL,
  category  text NOT NULL CHECK (category IN ('transactional','promotional')),
  purpose   text NOT NULL CHECK (purpose IN ('service','marketing')),
  content   jsonb NOT NULL,
  channels  jsonb,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE delivery_receipts (
  idempotency_key     text PRIMARY KEY,
  tenant_id           text NOT NULL,
  player_id           text NOT NULL,
  channel             text NOT NULL,
  template            text NOT NULL,
  locale              text NOT NULL,
  status              text NOT NULL CHECK (status IN ('accepted','failed','suppressed','deferred')),
  reason              text,
  provider_message_id text,
  attempts            int NOT NULL DEFAULT 0,
  at                  timestamptz NOT NULL
);
CREATE INDEX delivery_receipts_player ON delivery_receipts (tenant_id, player_id, at);

CREATE TABLE inbox_items (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL,
  player_id   text NOT NULL,
  template    text NOT NULL,
  category    text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  read_at     timestamptz,
  archived_at timestamptz
);
CREATE INDEX inbox_player ON inbox_items (tenant_id, player_id, created_at DESC);

-- ───────────── Recompensas (presupuesto transaccional) ─────────────
CREATE TABLE reward_items (
  tenant_id       text NOT NULL,
  reward_id       text NOT NULL,
  brand_id        text NOT NULL,
  reward_type     text NOT NULL,
  value_minor     bigint NOT NULL CHECK (value_minor > 0),
  currency        char(3) NOT NULL,
  validity_days   int NOT NULL,
  budget_minor    bigint NOT NULL CHECK (budget_minor >= 0),
  committed_minor bigint NOT NULL DEFAULT 0,
  max_multiplier  numeric(4,2) NOT NULL DEFAULT 1,
  approved_by     text,
  PRIMARY KEY (tenant_id, reward_id),
  -- reserva atómica: UPDATE … SET committed_minor = committed_minor + $v WHERE … falla si se pasa
  CHECK (committed_minor >= 0 AND committed_minor <= budget_minor)
);

CREATE TABLE reward_grants (
  idempotency_key text PRIMARY KEY,
  grant_id        text NOT NULL UNIQUE,
  tenant_id       text NOT NULL,
  player_id       text NOT NULL,
  reward_id       text NOT NULL,
  value_minor     bigint NOT NULL,
  currency        char(3) NOT NULL,
  status          text NOT NULL CHECK (status IN ('reserved','confirmed','failed','uncertain')),
  reason          text,
  multiplier      numeric(4,2),
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, reward_id) REFERENCES reward_items (tenant_id, reward_id)
);
CREATE INDEX reward_grants_player ON reward_grants (tenant_id, player_id);

-- ───────────── Fidelidad y gamificación ─────────────
CREATE TABLE loyalty_ledger (
  id        bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  brand_id  text NOT NULL,
  player_id text NOT NULL,
  points    bigint NOT NULL,
  reason    text NOT NULL,
  ref       text NOT NULL,
  at        timestamptz NOT NULL,
  UNIQUE (tenant_id, ref)
);
CREATE INDEX loyalty_player ON loyalty_ledger (tenant_id, player_id);

CREATE TABLE coin_ledger (
  id        bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  player_id text NOT NULL,
  amount    bigint NOT NULL,
  reason    text NOT NULL,
  ref       text NOT NULL,
  at        timestamptz NOT NULL,
  UNIQUE (tenant_id, ref)
);
-- saldo vigente (mantenido en la misma transacción que el movimiento)
CREATE TABLE coin_balances (
  tenant_id text NOT NULL,
  player_id text NOT NULL,
  balance   bigint NOT NULL CHECK (balance >= 0),
  PRIMARY KEY (tenant_id, player_id)
);

CREATE TABLE store_items (
  tenant_id        text NOT NULL,
  item_id          text NOT NULL,
  name             text NOT NULL,
  price_coins      int  NOT NULL CHECK (price_coins > 0),
  stock            int  NOT NULL CHECK (stock >= 0),
  per_player_limit int  NOT NULL CHECK (per_player_limit > 0),
  reward           jsonb NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, item_id)
);
CREATE TABLE redemptions (
  request_id text NOT NULL,
  tenant_id  text NOT NULL,
  player_id  text NOT NULL,
  item_id    text NOT NULL,
  status     text NOT NULL CHECK (status IN ('fulfilled','refunded')),
  reason     text,
  at         timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, request_id)
);

CREATE TABLE gamification_definitions (
  tenant_id  text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('mission','tournament','minigame','prediction')),
  id         text NOT NULL,
  status     text NOT NULL,
  definition jsonb NOT NULL,
  created_by text NOT NULL,
  approved_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, id)
);
CREATE TABLE gamification_progress (
  tenant_id text NOT NULL,
  kind      text NOT NULL,
  id        text NOT NULL,
  player_id text NOT NULL,
  state     jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, id, player_id)
);

-- ───────────── Riesgo ─────────────
CREATE TABLE rg_cases (
  case_id   text PRIMARY KEY,
  tenant_id text NOT NULL,
  player_id text NOT NULL,
  level     text NOT NULL CHECK (level IN ('medium','high')),
  score     int  NOT NULL,
  signals   jsonb NOT NULL,
  opened_at timestamptz NOT NULL,
  status    text NOT NULL CHECK (status IN ('open','in_review','closed')),
  assignee  text,
  outcome   text,
  notes     jsonb NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX rg_one_open_case ON rg_cases (tenant_id, player_id) WHERE status <> 'closed';

CREATE TABLE abuse_reviews (
  tenant_id   text NOT NULL,
  player_id   text NOT NULL,
  status      text NOT NULL CHECK (status IN ('cleared','confirmed')),
  by_actor    text NOT NULL,
  at          timestamptz NOT NULL,
  note        text NOT NULL,
  valid_until timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, player_id, at)
);

-- ───────────── Contenido en sitio y plantillas con IA ─────────────
CREATE TABLE onsite_campaigns (
  tenant_id  text NOT NULL,
  id         text NOT NULL,
  definition jsonb NOT NULL,
  status     text NOT NULL,
  created_by text NOT NULL,
  approved_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE TABLE onsite_interactions (
  tenant_id   text NOT NULL,
  request_id  text NOT NULL,
  type        text NOT NULL CHECK (type IN ('impression','click','dismiss')),
  campaign_id text NOT NULL,
  player_id   text NOT NULL,
  at          timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, request_id, type)
);
CREATE TABLE content_drafts (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  draft      jsonb NOT NULL,
  status     text NOT NULL,
  created_by text NOT NULL,
  approved_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Integración ─────────────
CREATE TABLE webhook_subscriptions (
  id                text PRIMARY KEY,
  tenant_id         text NOT NULL,
  url               text NOT NULL CHECK (url LIKE 'https://%'),
  events            text[] NOT NULL,
  description       text NOT NULL DEFAULT '',
  status            text NOT NULL CHECK (status IN ('active','paused','disabled')),
  -- el secreto se guarda cifrado con una llave del KMS (nunca en claro)
  secret_ciphertext text NOT NULL,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL,
  consecutive_failures int NOT NULL DEFAULT 0
);
CREATE TABLE webhook_deliveries (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL,
  subscription_id text NOT NULL REFERENCES webhook_subscriptions (id),
  event           text NOT NULL,
  body            jsonb NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  status          text NOT NULL CHECK (status IN ('pending','delivered','failed','dead')),
  next_at         timestamptz NOT NULL,
  last_status     int,
  created_at      timestamptz NOT NULL,
  delivered_at    timestamptz
);
CREATE INDEX webhook_due ON webhook_deliveries (next_at) WHERE status = 'pending';

-- Outbox transaccional: lo que se publica al bus sale de aquí (al menos una vez)
CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL,
  topic        text NOT NULL,
  key          text,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_pending ON outbox (id) WHERE published_at IS NULL;

-- Cuentas de servicio (máquina a máquina) con alcances; solo se guarda el hash de la llave
CREATE TABLE service_keys (
  key_id      text PRIMARY KEY,
  tenant_id   text NOT NULL,
  name        text NOT NULL,
  scopes      text[] NOT NULL,
  key_hash    text NOT NULL UNIQUE,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at  timestamptz
);

-- ───────────── Aislamiento por tenant (RLS) ─────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['events','dead_letters','player_profiles','audit_log','market_policies','policy_proposals','journey_versions','journey_instances','split_assignments',
    'templates','delivery_receipts','inbox_items','reward_items','reward_grants','loyalty_ledger','coin_ledger','coin_balances','store_items','redemptions',
    'gamification_definitions','gamification_progress','rg_cases','abuse_reviews','onsite_campaigns','onsite_interactions','content_drafts',
    'webhook_subscriptions','webhook_deliveries','outbox','service_keys'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true))$p$, t);
  END LOOP;
END $$;

-- Rol de la aplicación: sin BYPASSRLS ni propiedad de tablas. La contraseña la fija el despliegue.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN CREATE ROLE crm_app NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_app;
REVOKE UPDATE, DELETE ON events, audit_log FROM crm_app;
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM crm_app;
