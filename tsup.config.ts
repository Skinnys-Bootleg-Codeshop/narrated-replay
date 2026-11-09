import { defineConfig } from 'tsup';

const shared = { format: ['esm' as const], target: 'es2022', sourcemap: false, splitting: false };

export default defineConfig([
  { ...shared, entry: { 'recorder/index': 'src/recorder/index.ts' }, dts: true, clean: true, external: ['rrweb'] },
  {
    ...shared,
    entry: { 'react/index': 'src/react/index.tsx' },
    dts: true,
    external: ['react', 'rrweb'],
    banner: { js: '"use client";' },
  },
  {
    ...shared,
    entry: { 'viewer/index': 'src/viewer/index.tsx' },
    dts: true,
    external: ['react', 'rrweb-player'],
    banner: { js: '"use client";' },
  },
  {
    ...shared,
    entry: { 'server/index': 'src/server/index.ts' },
    dts: true,
    platform: 'node',
    external: ['zod'],
  },
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    platform: 'node',
    external: ['zod'],
  },
]);
