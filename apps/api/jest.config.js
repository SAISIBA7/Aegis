/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  // Run all test files sequentially in a single process. The tests spin up
  // real BullMQ workers, all attached to the same shared Redis connection,
  // so parallel test-file execution would let one file's worker process
  // another file's queued jobs.
  maxWorkers: 1,
  moduleNameMapper: {
    "^@aegis/shared$": "<rootDir>/../../packages/shared/src/index",
  },
  // Generous default; individual scenarios declare tighter timeouts.
  testTimeout: 600000,
  // Rely on real teardown (workers/queues/redis/prisma close), never forceExit:
  // a dangling resource here is exactly what Phase 7 is meant to catch.
  forceExit: false,
  verbose: false,
};