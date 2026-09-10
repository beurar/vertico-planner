// Bundles the renderer.
//
// The generated bindings are TypeScript that imports the `spacetimedb` package, so something has
// to turn them into one script the renderer can load. esbuild is that something and nothing more:
// there is no framework here, no JSX, no CSS pipeline — `styles.css` is served as it was written.

import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(here, 'src/renderer/main.ts')],
  outfile: path.join(here, 'dist/renderer.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  // Electron 44 ships Chrome 140; targeting it keeps modern syntax (including bigint literals,
  // which the u64 ids need) rather than down-levelling it.
  target: ['chrome140'],
  sourcemap: 'linked',
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching src/renderer …');
} else {
  await build(options);
}
