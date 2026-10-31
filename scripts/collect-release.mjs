// Копіює зібраний exe у release/ під назвою з версією.
import fs from 'node:fs';
import path from 'node:path';

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const src = path.join('src-tauri', 'target', 'release', 'CourtAnalyzer.exe');
fs.mkdirSync('release', { recursive: true });
const dest = path.join('release', `CourtAnalyzer-${version}.exe`);
fs.copyFileSync(src, dest);
console.log(`${dest}: ${(fs.statSync(dest).size / 1e6).toFixed(1)} МБ`);
