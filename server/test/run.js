'use strict';

/**
 * Serial test runner that avoids `node --test`'s child-process IPC.
 *
 * The stock runner spawns each file as a child and streams results over an
 * IPC pipe whose framing intermittently corrupts on CI runners ("Unable to
 * deserialize cloned data due to invalid or unsupported version" — a Node
 * test_runner bug we've now hit on both Node 20 and 22, even with
 * --test-concurrency=1). Running each file directly executes node:test
 * in-process: same TAP output, same nonzero exit on failure, no IPC at all.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let failed = 0;
for (const f of files) {
  process.stdout.write(`\n# ── ${f} ──\n`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    process.stdout.write(`# FAILED: ${f} (exit ${r.status})\n`);
  }
}

process.stdout.write(`\n# files: ${files.length}, failed: ${failed}\n`);
process.exit(failed ? 1 : 0);
