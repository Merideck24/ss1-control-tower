// Escribe contracts/openapi.json desde el catálogo. Uso: npm run openapi
import { writeFile } from 'node:fs/promises';
import { buildOpenApi } from '../src/api/openapi.ts';
import { CATALOG } from '../src/api/catalog.ts';
const out = new URL('../contracts/openapi.json', import.meta.url);
await writeFile(out, JSON.stringify(buildOpenApi(), null, 2) + '\n');
console.log(`OpenAPI escrita en contracts/openapi.json (${CATALOG.length} operaciones)`);
