// Копіює зібрану програму в release/ під назвою з версією:
// Windows — exe, macOS — dmg (CourtAnalyzer-<версія>-<arm64|x64>.dmg).
import fs from 'node:fs';
import path from 'node:path';

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const target = path.join('src-tauri', 'target', 'release');
const [src, dest] =
  process.platform === 'darwin'
    ? [
        path.join(target, 'bundle', 'dmg', `CourtAnalyzer_${version}_${process.arch === 'arm64' ? 'aarch64' : 'x64'}.dmg`),
        path.join('release', `CourtAnalyzer-${version}-${process.arch}.dmg`),
      ]
    : [path.join(target, 'CourtAnalyzer.exe'), path.join('release', `CourtAnalyzer-${version}.exe`)];
fs.mkdirSync('release', { recursive: true });
fs.copyFileSync(src, dest);
console.log(`${dest}: ${(fs.statSync(dest).size / 1e6).toFixed(1)} МБ`);
