import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

test('El build estático produce scripts válidos, config de orígenes y logos incrustados', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-build-'));
  try {
    execFileSync(process.execPath, ['scripts/build-static.mjs'], { env: { ...process.env, CRM_OUT_DIR: dir, CRM_ALLOWED_ORIGINS: 'https://admin.syssoft1.com,javascript:alert(1),https://staging.syssoft1.com' }, stdio: 'pipe' });
    for (const f of ['index.html', 'artifact.html']) {
      const html = readFileSync(join(dir, f), 'utf8');
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      assert.ok(scripts.length >= 3, `${f}: scripts encontrados`);
      for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s), `${f}: script con error de sintaxis`);
      assert.match(html, /SS1_CRM_CONFIG = \{"allowedOrigins":\["https:\/\/admin\.syssoft1\.com","https:\/\/staging\.syssoft1\.com"\]\}/);
      assert.ok(!html.includes('brand/ss1-logo.webp'), `${f}: logo incrustado`);
    }
    assert.ok(readFileSync(join(dir, 'artifact.html'), 'utf8').trimStart().startsWith('<meta name="claude:viewport-fit-sides"'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
