/**
 * Jest configuration — scoped to the tests/ directory.
 * Uses ts-jest to transpile TypeScript on-the-fly; no pre-build needed.
 */

/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/utils/**/*.ts',
    'src/middleware/**/*.ts',
    'src/controllers/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  verbose: true,
  errorOnDeprecated: true,
};
