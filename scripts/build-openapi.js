#!/usr/bin/env node
/**
 * Build docs/openapi.json and docs/openapi.yaml.
 *
 * Source of truth: docs/openapi.json (hand-edited).
 * The YAML companion is regenerated from the JSON for human-readable diffs.
 *
 * Usage: node scripts/build-openapi.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JSON_PATH = path.join(ROOT, 'docs', 'openapi.json');
const YAML_PATH = path.join(ROOT, 'docs', 'openapi.yaml');

if (!fs.existsSync(JSON_PATH)) {
  console.error(`Missing ${JSON_PATH}. Restore or hand-edit it first.`);
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

// ── Minimal JSON → YAML emitter ─────────────────────────────────────────────

function escapeYamlString(s) {
  if (s === null || s === undefined) return 'null';
  return s;
}

function emit(value, indent = 0) {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (/^[a-zA-Z0-9 _./:-]+$/.test(value) && !value.startsWith('-')) return value;
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map(item => {
      const inner = emit(item, indent + 1);
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        // First key on its line, rest indented
        const lines = inner.split('\n');
        return `${pad}- ${lines[0].trim()}\n` + lines.slice(1).map(l => `${pad}  ${l}`).join('\n');
      }
      return `${pad}- ${inner}`;
    }).join('\n');
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return keys.map(k => {
      const v = value[k];
      if (v === null || v === undefined) return `${pad}${k}: null`;
      if (Array.isArray(v) || (typeof v === 'object' && v !== null)) {
        return `${pad}${k}:\n${emit(v, indent + 1)}`;
      }
      return `${pad}${k}: ${emit(v, indent)}`;
    }).join('\n');
  }
  return String(value);
}

const yaml = [
  `# Auto-generated from openapi.json — do not hand-edit.`,
  `# Regenerate with: npm run docs:build`,
  ``,
  emit(spec),
].join('\n');

fs.writeFileSync(YAML_PATH, yaml);
console.log(`Wrote ${YAML_PATH}`);
console.log(`Source: ${JSON_PATH} (hand-edited, source of truth)`);