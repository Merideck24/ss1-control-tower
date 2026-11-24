/**
 * E6 · Moderación de contenido de marketing de juego (determinista y auditable).
 * Se aplica a todo borrador, lo escriba una persona o la IA. «block» impide enviarlo
 * a aprobación; «warn» queda visible para quien aprueba. Las reglas son un punto de
 * partida que Cumplimiento debe ajustar por mercado.
 */
export type ModerationIssue = { severity: 'block' | 'warn'; code: string; message: string; locale?: string; field?: string };
export type DraftText = { subject?: string; body: string; sms?: string };

export const MODERATION_RULES = { version: 'mod-2026.11', subject_max: 60, body_max: 600, sms_max: 160 } as const;

const BLOCK_PATTERNS: [RegExp, string, string][] = [
  [/gana(r|s)? (dinero )?(seguro|garantizad)|ganancia(s)? (segura|garantizada)|sin riesgo|no puedes perder|guaranteed win|risk[- ]free|ganho garantido|sem risco/i, 'guaranteed_win', 'Promete ganancias seguras o sin riesgo.'],
  [/recupera(r)? (lo|tus pérdidas|lo perdido)|chase your losses|recupere suas perdas/i, 'loss_chasing', 'Invita a recuperar pérdidas.'],
  [/préstamo|pide prestado|crédito rápido|borrow money|empréstimo/i, 'credit_pressure', 'Sugiere endeudarse para jugar.'],
  [/menores|niñ[oa]s|colegio|escuela|teen|kids|crianças/i, 'minors', 'Hace referencia a menores.'],
  [/(solución|salida) a tus (problemas|deudas)|cambia tu vida|hazte rico|get rich|fique rico/i, 'financial_solution', 'Presenta el juego como solución económica.'],
  [/autoexcl|self[- ]?exclu/i, 'targets_excluded', 'Menciona la autoexclusión en un mensaje promocional.'],
];
const WARN_PATTERNS: [RegExp, string, string][] = [
  [/solo hoy|última oportunidad|ahora o nunca|ya mismo|apúrate|hurry|last chance|só hoje/i, 'urgency', 'Presión de urgencia: revisa si es necesaria.'],
  [/gratis|free|grátis/i, 'free_claim', 'Dice «gratis»: confirma que no hay requisito de apuesta oculto o muéstralo.'],
];
const RG_FOOTER = /juega con responsabilidad|juego responsable|\+18|18\+|play responsibly|jogue com responsabilidade/i;

/** Revisa un borrador por idioma. `allowedVars` son las variables que la plantilla puede usar. */
export function moderate(texts: Partial<Record<string, DraftText>>, opts: { purpose: 'marketing' | 'service'; allowedVars: string[]; brandDomains?: string[] }): ModerationIssue[] {
  const R = MODERATION_RULES;
  const issues: ModerationIssue[] = [];
  const domains = opts.brandDomains ?? ['rumbawin.com', 'syssoft1.com'];
  for (const [locale, t] of Object.entries(texts)) {
    if (!t) continue;
    const fields: [string, string | undefined][] = [['subject', t.subject], ['body', t.body], ['sms', t.sms]];
    for (const [field, text] of fields) {
      if (!text) continue;
      for (const [re, code, msg] of BLOCK_PATTERNS) if (re.test(text) && !(code === 'targets_excluded' && opts.purpose === 'service')) issues.push({ severity: 'block', code, message: msg, locale, field });
      if (opts.purpose === 'marketing') for (const [re, code, msg] of WARN_PATTERNS) if (re.test(text)) issues.push({ severity: 'warn', code, message: msg, locale, field });
      for (const v of text.matchAll(/\{\{(\w+)\}\}/g)) if (!opts.allowedVars.includes(v[1])) issues.push({ severity: 'block', code: 'unknown_variable', message: `Usa la variable {{${v[1]}}}, que no existe para esta plantilla.`, locale, field });
      if (/\{\{[^}]*$|^[^{]*\}\}/.test(text)) issues.push({ severity: 'block', code: 'broken_variable', message: 'Hay una variable mal cerrada.', locale, field });
      for (const u of text.match(/https?:\/\/[^\s)]+/g) ?? []) {
        let ok = false; try { const x = new URL(u); ok = x.protocol === 'https:' && domains.some((d) => x.hostname === d || x.hostname.endsWith(`.${d}`)); } catch { /* inválida */ }
        if (!ok) issues.push({ severity: 'block', code: 'external_link', message: `Enlace no permitido: ${u} (solo https de la marca).`, locale, field });
      }
      if (/<[^>]+>/.test(text)) issues.push({ severity: 'block', code: 'html', message: 'Solo texto plano, sin HTML.', locale, field });
      if (/\b[\w.+-]+@[\w-]+\.[\w.]+\b|\+?\d[\d\s-]{8,}\d/.test(text)) issues.push({ severity: 'block', code: 'pii', message: 'Contiene un email o teléfono: los datos de contacto no van en plantillas.', locale, field });
      const letters = text.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '');
      if (letters.length > 12 && letters.replace(/[^A-ZÁÉÍÓÚÑ]/g, '').length / letters.length > 0.5) issues.push({ severity: 'warn', code: 'shouting', message: 'Demasiadas mayúsculas.', locale, field });
      if ((text.match(/!/g) ?? []).length > 2) issues.push({ severity: 'warn', code: 'exclamations', message: 'Más de dos signos de exclamación.', locale, field });
    }
    if (t.subject && t.subject.length > R.subject_max) issues.push({ severity: 'block', code: 'subject_too_long', message: `Asunto de más de ${R.subject_max} caracteres.`, locale, field: 'subject' });
    if (t.body.length > R.body_max) issues.push({ severity: 'block', code: 'body_too_long', message: `Texto de más de ${R.body_max} caracteres.`, locale, field: 'body' });
    if (t.sms && t.sms.length > R.sms_max) issues.push({ severity: 'block', code: 'sms_too_long', message: `SMS de más de ${R.sms_max} caracteres.`, locale, field: 'sms' });
    // el aviso va en cada texto que puede leerse por separado (email/in-app y SMS)
    if (opts.purpose === 'marketing' && !RG_FOOTER.test(t.body)) issues.push({ severity: 'block', code: 'missing_rg_notice', message: 'Falta el aviso de juego responsable en el texto (p. ej. «Juega con responsabilidad. +18»).', locale, field: 'body' });
    if (opts.purpose === 'marketing' && t.sms && !RG_FOOTER.test(t.sms)) issues.push({ severity: 'block', code: 'missing_rg_notice', message: 'Falta «+18» o el aviso de juego responsable en el SMS.', locale, field: 'sms' });
  }
  return issues;
}
