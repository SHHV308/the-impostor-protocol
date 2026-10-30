import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(root, 'server/src/index.ts')],
  outfile: path.join(root, 'dist/server/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  alias: { '@impostor/shared': path.join(root, 'shared/src/index.ts') },
  sourcemap: true,
  logLevel: 'info',
});
