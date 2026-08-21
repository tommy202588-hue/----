import { build } from 'esbuild';

await build({
  entryPoints: ['vite.config.ts'],
  outfile: 'electron/vite.config.bundle.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: [
    'vite',
    '@babel/preset-flow/package.json',
    '@babel/preset-typescript/package.json',
  ],
  logLevel: 'info',
});
