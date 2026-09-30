import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['packages/server/src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
await build({
  entryPoints: ['packages/sdk-js/src/index.ts'],
  outfile: 'dist/sdk.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
});
await build({
  entryPoints: ['examples/demo.ts'],
  outfile: 'dist/demo.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
});
await cp('packages/inspector/dist', 'dist/inspector', { recursive: true });
console.log('Built server CLI, JS SDK and embedded inspector in dist/');
