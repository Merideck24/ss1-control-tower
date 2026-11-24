// Genera integrations/ss1-admin/crm/api/endpoints.generated.ts desde el catálogo de la API.
// Uso: npm run admin:client   (una prueba falla si el archivo publicado queda desactualizado)
import { writeFile } from 'node:fs/promises';
import { renderEndpoints } from '../src/api/adminClientGen.ts';

const out = new URL('../integrations/ss1-admin/crm/api/endpoints.generated.ts', import.meta.url);
await writeFile(out, renderEndpoints());
console.log('Cliente del admin generado en integrations/ss1-admin/crm/api/endpoints.generated.ts');
