import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts'],
  format: ['esm'],
  sourcemap: true,
  clean: true,
});
