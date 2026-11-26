// Genera la versión estática del backoffice (sin servidor):
//   dist/index.html     documento completo para GitHub Pages
//   dist/artifact.html  contenido de página (sin doctype/html/head/body) para Claude Artifacts
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const out = await build({ entryPoints: ['src/browser.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'none' });
const bundle = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const page = await readFile('public/index.html', 'utf8');
const marker = '<script>\n// pestaña';
if (!page.includes(marker)) throw new Error('main script marker not found');
// función de reemplazo: un texto de reemplazo interpretaría secuencias como $& dentro del código minificado
let withBundle = page.replace(marker, () => `<script>${bundle}</script>\n${marker}`);
// orígenes del admin permitidos para el modo embebido: solo por configuración de despliegue
if (process.env.CRM_ALLOWED_ORIGINS) {
  const origins = process.env.CRM_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter((o) => /^https?:\/\/[\w.-]+(:\d+)?$/.test(o));
  withBundle = withBundle.replace('<script>\n// pestaña', () => `<script>window.SS1_CRM_CONFIG = ${JSON.stringify({ allowedOrigins: origins })};</script>\n<script>\n// pestaña`);
}
// recursos de marca incrustados (la versión estática no carga archivos sueltos)
for (const f of ['brand/ss1-logo.webp', 'brand/ss1-icon.webp']) {
  const uri = `data:image/webp;base64,${(await readFile(`public/${f}`)).toString('base64')}`;
  withBundle = withBundle.split(f).join(uri);
}
// tipografía incrustada: la demo no depende de Google Fonts ni de ningún otro origen
for (const w of [400, 500, 700]) {
  const f = `fonts/roboto-latin-${w}-normal.woff2`;
  withBundle = withBundle.split(f).join(`data:font/woff2;base64,${(await readFile(`public/${f}`)).toString('base64')}`);
}
if (/fonts\.googleapis|fonts\.gstatic/.test(withBundle)) throw new Error('la versión estática no debe cargar fuentes externas');

const outDir = process.env.CRM_OUT_DIR ?? 'dist';
await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/index.html`, withBundle);
await writeFile(`${outDir}/.nojekyll`, '');
const artifact = withBundle
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*/i, '')
  .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '')
  .replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '')
  .replace(/<meta charset="utf-8">\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
await writeFile(`${outDir}/artifact.html`, artifact);
console.log(`dist/index.html ${(withBundle.length / 1024).toFixed(0)} KB · dist/artifact.html ${(artifact.length / 1024).toFixed(0)} KB`);
