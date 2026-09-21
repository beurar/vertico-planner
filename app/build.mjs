// Bundles the renderer.
//
// The generated bindings are TypeScript that imports the `spacetimedb` package, so something has
// to turn them into one script the renderer can load. esbuild is that something and nothing more:
// there is no framework here, no JSX, no CSS pipeline — `styles.css` is served as it was written.

import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const web = process.argv.includes('--web');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(here, 'src/renderer/main.ts')],
  outfile: path.join(here, web ? 'dist-web/renderer.js' : 'dist/renderer.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  // Electron 44 ships Chrome 140, and GitHub Pages only has to run in browsers a team actually
  // uses day to day — both comfortably support the same modern syntax (including bigint
  // literals, which the u64 ids need), so one target list covers both builds.
  target: ['chrome140'],
  sourcemap: 'linked',
  logLevel: 'info',
};

if (web) {
  // The GitHub Pages target: same renderer bundle, plus the browser stand-ins for the Electron
  // preload bridge (`web/bridge.js`, `web/index.html`) instead of `index.html` + `preload.js`.
  // `version.json` is deliberately NOT written here — the deploy workflow writes it with the
  // commit actually being published, which is the only thing `update-check.js` can trust.
  await build(options);
  const outDir = path.join(here, 'dist-web');
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(path.join(here, 'web/index.html'), path.join(outDir, 'index.html'));
  await fs.copyFile(path.join(here, 'web/bridge.js'), path.join(outDir, 'bridge.js'));
  await fs.copyFile(path.join(here, 'web/update-check.js'), path.join(outDir, 'update-check.js'));
  await fs.copyFile(path.join(here, 'styles.css'), path.join(outDir, 'styles.css'));
  console.log(`web build written to ${outDir}`);
} else if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching src/renderer …');
} else {
  await build(options);
}
