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
const withBundle = page.replace(marker, `<script>${bundle}</script>\n${marker}`);

await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', withBundle);
await writeFile('dist/.nojekyll', '');
const artifact = withBundle
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*/i, '')
  .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '')
  .replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '')
  .replace(/<meta charset="utf-8">\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
await writeFile('dist/artifact.html', artifact);
console.log(`dist/index.html ${(withBundle.length / 1024).toFixed(0)} KB · dist/artifact.html ${(artifact.length / 1024).toFixed(0)} KB`);
