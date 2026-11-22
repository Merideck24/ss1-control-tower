import { stableBucket } from '../shared/util.ts';

/** Asignación persistente y comparable: hash(tenant, campaign, player) (CRM-09). */
export function assignArm(tenant: string, campaign: string, player: string, controlPct: number): 'treatment' | 'control' {
  return stableBucket(`${tenant}::${campaign}::${player}`) < controlPct / 100 ? 'control' : 'treatment';
}

export type ArmStats = { n: number; conversions: number };
export type CampaignReport = {
  campaign: string;
  window: { from: string; to: string };
  primary_metric: string;
  treatment: ArmStats & { rate: number };
  control: ArmStats & { rate: number };
  observed_conversion: number; // conversión observada en tratamiento
  estimated_lift: { absolute: number; ci95: [number, number]; reliable: boolean; note?: string };
  cost_minor: number;
  currency: string;
};

/** Diferencia absoluta de proporciones con IC 95 % (aprox. normal). */
export function report(input: { campaign: string; window: { from: string; to: string }; primary_metric: string; treatment: ArmStats; control: ArmStats; cost_minor: number; currency: string; min_n?: number }): CampaignReport {
  const rt = input.treatment.n ? input.treatment.conversions / input.treatment.n : 0;
  const rc = input.control.n ? input.control.conversions / input.control.n : 0;
  const diff = rt - rc;
  const se = Math.sqrt((input.treatment.n ? (rt * (1 - rt)) / input.treatment.n : 0) + (input.control.n ? (rc * (1 - rc)) / input.control.n : 0));
  const minN = input.min_n ?? 100;
  const reliable = input.treatment.n >= minN && input.control.n >= minN;
  return {
    campaign: input.campaign, window: input.window, primary_metric: input.primary_metric,
    treatment: { ...input.treatment, rate: rt }, control: { ...input.control, rate: rc },
    observed_conversion: rt,
    estimated_lift: { absolute: diff, ci95: [diff - 1.96 * se, diff + 1.96 * se], reliable, note: reliable ? undefined : `muestra insuficiente (<${minN} por brazo)` },
    cost_minor: input.cost_minor, currency: input.currency,
  };
}
