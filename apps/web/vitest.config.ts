import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            '#shared': resolve(import.meta.dirname, 'shared'),
        },
    },
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
        testTimeout: 40_000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            reportsDirectory: 'coverage',
            // 当前基线约 74%，留出少量余量防止覆盖率随重构下降
            thresholds: {
                statements: 70,
                branches: 55,
                functions: 70,
                lines: 70,
            },
        },
        // 每个 worker 都会加载 better-sqlite3/sharp/onnxruntime，Windows 上跑满 fork 容易崩
        maxWorkers: 4,
        minWorkers: 1,
    },
});
