import * as esbuild from 'esbuild';
import {
  existsSync,
  cpSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const isWatch = process.argv.includes('--watch');
const isFirefox = process.argv.includes('--target=firefox');

const distDir = isFirefox ? 'dist-firefox' : 'dist';

/** @type {esbuild.BuildOptions[]} */
const buildConfigs = [
  {
    entryPoints: ['src/background/service-worker.ts'],
    outfile: `${distDir}/background.js`,
    format: isFirefox ? 'iife' : 'esm',
  },
  {
    entryPoints: ['src/content/content-entry.ts'],
    outfile: `${distDir}/content.js`,
    format: 'iife',
  },
  {
    entryPoints: ['src/options/options.ts'],
    outfile: `${distDir}/options.js`,
    format: 'iife',
  },
  {
    entryPoints: ['src/popup/popup.ts'],
    outfile: `${distDir}/popup.js`,
    format: 'iife',
  },
].map((config) => ({
  bundle: true,
  minify: true,
  sourcemap: true,
  ...config,
  ...(isFirefox ? { define: { chrome: 'browser' } } : {}),
}));

function copyIfExists(src, dest) {
  if (!existsSync(src)) {
    return;
  }
  const destDir = dirname(dest);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }
  copyFileSync(src, dest);
}

function copyDirIfExists(src, dest) {
  if (!existsSync(src)) {
    return;
  }
  cpSync(src, dest, { recursive: true });
}

function writeManifest() {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf-8'));
  if (isFirefox) {
    const patch = JSON.parse(readFileSync('manifest.firefox.json', 'utf-8'));
    delete manifest.background; // service_worker + type:module out
    Object.assign(manifest, patch); // ponytail: flat merge is enough for these top-level deltas
  }
  writeFileSync(`${distDir}/manifest.json`, JSON.stringify(manifest, null, 2));
}

function copyStaticAssets() {
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  writeManifest();
  copyIfExists('src/options/options.html', `${distDir}/options.html`);
  copyIfExists('src/options/options.css', `${distDir}/options.css`);
  copyIfExists('src/popup/popup.html', `${distDir}/popup.html`);
  copyIfExists('src/popup/popup.css', `${distDir}/popup.css`);
  copyIfExists('src/content/styles.css', `${distDir}/content.css`);
  copyDirIfExists('icons', `${distDir}/icons`);
}

async function run() {
  if (isWatch) {
    const contexts = await Promise.all(
      buildConfigs.map((config) => esbuild.context(config))
    );
    copyStaticAssets();
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('esbuild watching for changes...');
  } else {
    await Promise.all(buildConfigs.map((config) => esbuild.build(config)));
    copyStaticAssets();
    console.log('esbuild build complete.');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
