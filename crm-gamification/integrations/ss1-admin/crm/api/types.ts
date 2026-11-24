// Formas de respuesta que usan las vistas nativas (subconjunto estable de contracts/openapi.json).
export type Session = { actor: { id: string; tenant_id: string; roles: string[] }; permissions: string[] }

export type Latency = { n: number; p50_ms: number | null; p95_ms: number | null; p99_ms: number | null; slo_p95_ms: number; within_slo: boolean | null }
export type ControlTower = {
  as_of: string
  global_pause: boolean
  brand: string | null
  latency: Latency
  journeys: { id: string; name: string; version: number; status: string; purpose: 'service' | 'marketing'; control_group_pct: number; instances: Record<string, number> }[]
  deliveries: Record<string, number>
  suppression_reasons: Record<string, number>
  deferred: number
  dead_letters: number
  budgets: { reward_id: string; budget_minor: number; committed_minor: number; remaining_minor: number }[]
  alerts: { at: string; player_id: string; alert: string }[]
}

export type RiskSignal = { code: string; label: string; detail: string; points: number }
export type RgCase = { case_id: string; player_id: string; level: 'medium' | 'high'; score: number; signals: RiskSignal[]; opened_at: string; status: 'open' | 'in_review' | 'closed'; assignee?: string; outcome?: string; notes: { at: string; by: string; text: string }[] }
export type RgMonitor = {
  summary: { open: number; high: number; medium: number; in_review: number; closed: number; marketing_on_hold: number }
  signals: { code: string; label: string; cases: number }[]
  interventions: { started: number; messages_accepted: number; messages_not_sent: number }
  cases: RgCase[]
  note: string
}

export type MarketPolicy = { version: string; brand_id: string; market: string; channels_enabled: string[]; max_marketing_per_day: number; max_marketing_per_week?: number; max_marketing_per_day_by_channel?: Record<string, number>; quiet_hours: { start: number; end: number }; incentives_allowed: boolean; require_kyc_for_incentives: boolean; rg_feed_max_staleness_ms: number }
export type PolicyChange = { field: string; from: unknown; to: unknown; loosens: boolean }
export type PolicyProposal = { id: string; market: string; brand_id: string; base_version: string | null; proposed: MarketPolicy; changes: PolicyChange[]; justification: string; status: 'pending' | 'approved' | 'rejected' | 'superseded'; proposed_by: string; decided_by?: string; reject_reason?: string }
export type Policies = { policies: (MarketPolicy & { history: { version: string; approved_by: string; at: string }[]; pending: number })[]; proposals: PolicyProposal[]; note: string }

export type WebhookSubscription = { id: string; url: string; events: string[]; description: string; status: 'active' | 'paused' | 'disabled'; secret_hint: string; deliveries: { delivered: number; pending: number; failed: number; dead: number } }
export type Webhooks = { events: string[]; subscriptions: WebhookSubscription[]; recent: { id: string; event: string; status: string; attempts: number; last_status?: number; created_at: string }[]; note: string }
export type ServiceKey = { key_id: string; name: string; scopes: string[]; created_by: string; created_at: string; last_used_at?: string; revoked_at?: string }
