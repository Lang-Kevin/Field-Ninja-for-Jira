// geckodriver's addon:install nimmt eine Datei, kein Verzeichnis. Ein XPI ist
// ein gewöhnliches ZIP, also packt PowerShell das — kein neues npm-Paket dafür.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export async function packXpi(distDir, outPath) {
  if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error(`${distDir}/manifest.json fehlt — erst \`npm run build:firefox\``);
  }
  fs.rmSync(outPath, { force: true });
  const zip = outPath.replace(/\.xpi$/, '.zip');
  fs.rmSync(zip, { force: true });
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${path.join(distDir, '*')}' -DestinationPath '${zip}' -Force`,
  ], { stdio: 'inherit' });
  fs.renameSync(zip, outPath);
  return outPath;
}
