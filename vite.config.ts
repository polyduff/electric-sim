import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 120000,
  },
});
