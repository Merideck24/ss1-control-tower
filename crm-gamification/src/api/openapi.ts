/**
 * Genera la especificación OpenAPI 3.1 desde el catálogo (src/api/catalog.ts).
 * `npm run openapi` la escribe en contracts/openapi.json; una prueba falla si el archivo
 * publicado no coincide con lo que generaría el código (sin deriva).
 */
import { CATALOG, SCOPES, type Endpoint } from './catalog.ts';
import { PERMISSIONS } from './router.ts';

export const API_VERSION = '1.0.0';

function toPath(e: Endpoint): { method: string; path: string; params: { name: string; enum?: string[] }[] } {
  const [method, pattern] = e.route.split(' ');
  const params: { name: string; enum?: string[] }[] = [];
  let i = 0;
  const path = pattern.replace(/\(([^()]+)\)/g, (_m, inner: string) => {
    const name = e.params?.[i++] ?? `p${i}`;
    const alts = /^[\w-]+(\|[\w-]+)+$/.test(inner) ? inner.split('|') : undefined;
    params.push({ name, ...(alts ? { enum: alts } : {}) });
    return `{${name}}`;
  }).replace(/\\\//g, '/');
  return { method: method.toLowerCase(), path, params };
}

export const operationIdOf = (method: string, path: string) => `${method}${path.replace(/[{}]/g, '').split(/[/._-]/).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1)).join('')}`;

/** Operaciones para generar clientes (ruta sin el prefijo /v1). */
export function listOperations() {
  return CATALOG.map((e) => { const { method, path, params } = toPath(e); return { operationId: operationIdOf(method, path), method: method.toUpperCase(), path, params: params.map((p) => ({ name: p.name, ...(p.enum ? { enum: p.enum } : {}) })), query: e.query ?? [], scope: e.scope, summary: e.summary }; });
}

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of CATALOG) {
    const { method, path, params } = toPath(e);
    const perms = e.perm === null ? [] : Array.isArray(e.perm) ? e.perm : [e.perm];
    const roles = [...new Set(perms.flatMap((p) => PERMISSIONS[p] ?? []))];
    const isPublic = e.route === 'GET /health' || e.route === 'GET /openapi.json';
    paths[`/v1${path}`] ??= {};
    paths[`/v1${path}`][method] = {
      tags: [e.tag],
      summary: e.summary,
      operationId: operationIdOf(method, path),
      description: [
        perms.length ? `Permiso de rol: ${perms.map((p) => `\`${p}\``).join(' o ')} (${roles.join(', ')}).` : 'Cualquier usuario autenticado del tenant.',
        e.scope ? `Llaves de servicio: alcance \`${e.scope}\`.` : 'No disponible para llaves de servicio.',
        e.body ? `Cuerpo: \`${e.body}\`.` : '',
      ].filter(Boolean).join(' '),
      parameters: [
        ...params.map((p) => ({ name: p.name, in: 'path', required: true, schema: { type: 'string', ...(p.enum ? { enum: p.enum } : {}) } })),
        ...(e.query ?? []).map((q) => ({ name: q, in: 'query', required: false, schema: { type: 'string' } })),
        ...(isPublic ? [] : [{ $ref: '#/components/parameters/TenantId' }]),
      ],
      ...(method === 'post' || method === 'put' ? { requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: true, ...(e.body ? { description: e.body } : {}) } } } } } : {}),
      responses: {
        200: { description: 'Correcto', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        ...(method === 'post' ? { 201: { description: 'Creado' } } : {}),
        ...(isPublic ? {} : { 401: { $ref: '#/components/responses/Error' }, 403: { $ref: '#/components/responses/Error' } }),
        422: { $ref: '#/components/responses/Error' },
      },
      security: isPublic ? [] : [{ ss1AdminToken: [] }, ...(e.scope ? [{ serviceKey: [e.scope] }] : [])],
      'x-ss1-scope': e.scope,
      'x-ss1-permission': perms,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'SS1 CRM y Gamificación — API de integración', version: API_VERSION,
      description: 'API del CRM para el ecosistema SS1. Base: `/api/v1` (también se acepta `/api`). Personas: token del admin (admin.syssoft1.com) validado contra api.syssoft1.com; los roles salen de las habilidades CASL. Sistemas: llave de servicio con alcances. Todas las respuestas son JSON salvo `format=csv`. Montos en unidades mínimas con moneda ISO. Errores: `{ error, message }`.',
    },
    servers: [{ url: '/api' }],
    tags: [...new Set(CATALOG.map((e) => e.tag))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        ss1AdminToken: { type: 'http', scheme: 'bearer', description: 'Token del usuario del admin de SS1; el CRM lo valida contra api.syssoft1.com y deriva tenant y roles.' },
        serviceKey: { type: 'http', scheme: 'bearer', bearerFormat: 'ss1crm_<key_id>_<secreto>', description: `Llave de servicio. Alcances: ${Object.entries(SCOPES).map(([k, v]) => `\`${k}\` (${v})`).join('; ')}. Límite: 600 peticiones por minuto por llave (429 con Retry-After).` },
      },
      parameters: {
        TenantId: { name: 'X-Tenant-Id', in: 'header', required: false, schema: { type: 'string' }, description: 'Con token del admin, el tenant sale del token; con llave de servicio, de la llave. Solo se usa en desarrollo.' },
      },
      responses: {
        Error: { description: 'Error', content: { 'application/json': { schema: { type: 'object', required: ['error'], properties: { error: { type: 'string' }, message: { type: 'string' } } } } } },
      },
    },
  };
}
