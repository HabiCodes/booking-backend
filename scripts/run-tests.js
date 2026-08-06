#!/usr/bin/env node
/**
 * Test runner — compiles TypeScript tests + source on demand and runs them
 * through Node's built-in test runner.
 *
 * Why: This environment has a restricted npm registry, so we can't install
 *      `jest` or `ts-jest`. Node 22 ships with `--test` and `--experimental-strip-types`
 *      built in, but ESM resolution requires `.ts` import suffixes everywhere.
 *      Compiling to a sibling `dist-tests/` directory lets the test files import
 *      source using the normal CommonJS Node resolution that the rest of the
 *      codebase already uses.
 *
 * Usage:
 *   node scripts/run-tests.js                  # all tests
 *   node scripts/run-tests.js tests/unit       # unit only
 *   node scripts/run-tests.js tests/unit/foo.test.ts  # one file
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS_OUT = path.join(ROOT, '.test-build');

function log(msg) {
  process.stderr.write(`[test] ${msg}\n`);
}

function compileTests() {
  if (!fs.existsSync(TESTS_OUT)) fs.mkdirSync(TESTS_OUT, { recursive: true });

  log(`Compiling src/ → ${path.relative(ROOT, TESTS_OUT)}/src`);
  const compileSrc = spawnSync(
    path.join(ROOT, 'node_modules', '.bin', 'tsc'),
    [
      '--project',
      'tsconfig.test.json',
    ],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] }
  );
  if (compileSrc.status !== 0) {
    process.exit(compileSrc.status ?? 1);
  }
}

function discoverTests() {
  const arg = process.argv[2];
  if (!arg) {
    // Default: all .test.js files under .test-build/tests/
    const testsRoot = path.join(TESTS_OUT, 'tests');
    return walk(testsRoot).filter((f) => f.endsWith('.test.js'));
  }
  const abs = path.resolve(arg);
  if (abs.startsWith(TESTS_OUT) && abs.endsWith('.test.js')) return [abs];
  if (abs.startsWith(path.join(ROOT, 'tests')) && abs.endsWith('.test.ts')) {
    return [abs.replace(/\.test\.ts$/, '.test.js').replace(path.join(ROOT, 'tests'), path.join(TESTS_OUT, 'tests'))];
  }
  log(`Unrecognized argument: ${arg}`);
  process.exit(2);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function main() {
  compileTests();
  const files = discoverTests();
  if (files.length === 0) {
    log('No tests found.');
    process.exit(0);
  }
  log(`Running ${files.length} test file(s)`);
  const result = spawnSync(
    process.execPath,
    ['--test', ...files],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test', LOG_FILE_ENABLED: 'false' } }
  );
  process.exit(result.status ?? 0);
}

main();