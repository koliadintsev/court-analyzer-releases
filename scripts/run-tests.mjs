// Запуск тестів: node scripts/run-tests.mjs [фільтр]. Мережеві тести — лише з LIVE=1.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const filter = process.argv[2] ?? '';
const files = fs
  .readdirSync('tests')
  .filter((f) => f.endsWith('.test.ts') && f.includes(filter))
  .filter((f) => process.env.LIVE || !f.startsWith('live'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'court-analyzer-tests-'));
let failed = 0;
for (const f of files) {
  const outfile = path.join(outDir, f.replace(/\.ts$/, '.cjs'));
  await build({ entryPoints: [path.join('tests', f)], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile, logLevel: 'error' });
  console.log(`\n▶ ${f}`);
  const r = spawnSync(process.execPath, [outfile], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n✖ Не пройшло: ${failed}` : `\n✔ Усі тести пройшли (${files.length})`);
process.exit(failed ? 1 : 0);
