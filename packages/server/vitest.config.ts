import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The pipeline tests each boot an isolated app on a temp dir; running them
    // in one thread keeps SQLite file handles and env mutation predictable.
    pool: 'threads',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
