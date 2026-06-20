import * as esbuild from 'esbuild';
import { existsSync, cpSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const isWatch = process.argv.includes('--watch');

const distDir = 'dist';

/** @type {esbuild.BuildOptions[]} */
const buildConfigs = [
  {
    entryPoints: ['src/background/service-worker.ts'],
    outfile: 'dist/background.js',
    format: 'esm',
  },
  {
    entryPoints: ['src/content/content-entry.ts'],
    outfile: 'dist/content.js',
    format: 'iife',
  },
  {
    entryPoints: ['src/options/options.ts'],
    outfile: 'dist/options.js',
    format: 'iife',
  },
  {
    entryPoints: ['src/popup/popup.ts'],
    outfile: 'dist/popup.js',
    format: 'iife',
  },
].map((config) => ({
  bundle: true,
  minify: true,
  sourcemap: true,
  ...config,
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

function copyStaticAssets() {
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  copyIfExists('manifest.json', 'dist/manifest.json');
  copyIfExists('src/options/options.html', 'dist/options.html');
  copyIfExists('src/options/options.css', 'dist/options.css');
  copyIfExists('src/popup/popup.html', 'dist/popup.html');
  copyIfExists('src/popup/popup.css', 'dist/popup.css');
  copyIfExists('src/content/styles.css', 'dist/content.css');
  copyDirIfExists('icons', 'dist/icons');
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
