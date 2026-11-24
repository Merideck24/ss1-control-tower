import { listOperations } from './openapi.ts';

/** Código del mapa de operaciones para el cliente del admin (Vue). Determinista. */
export function renderEndpoints(): string {
  const ops = listOperations();
  const lines = ops.map((o) => {
    const params = o.params.map((p) => (p.enum ? `${p.name}: ${p.enum.map((x) => `'${x}'`).join(' | ')}` : `${p.name}: string`));
    return `  /** ${o.summary.replace(/\*\//g, '*\\/')}${o.scope ? ` · alcance ${o.scope}` : ''} */\n  ${o.operationId}: { method: '${o.method}', path: '${o.path}', params: [${o.params.map((p) => `'${p.name}'`).join(', ')}] as const, query: [${o.query.map((q) => `'${q}'`).join(', ')}] as const } as Op<{ ${params.join('; ')} }>,`;
  });
  return `// Generado por \`npm run admin:client\` desde src/api/catalog.ts. No editar a mano.
/* eslint-disable */
export type Op<P> = { method: 'GET' | 'POST' | 'PUT'; path: string; params: readonly string[]; query: readonly string[]; __params?: P };

export const CRM_ENDPOINTS = {
${lines.join('\n')}
} as const;

export type CrmOperation = keyof typeof CRM_ENDPOINTS;
export type ParamsOf<K extends CrmOperation> = (typeof CRM_ENDPOINTS)[K] extends Op<infer P> ? P : never;
`;
}
