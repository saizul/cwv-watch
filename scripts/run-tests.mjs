// Runs every compiled test file with the built-in node:test runner.
// Listing the files here keeps the command identical on Node 20, 22 and 24,
// whose --test flags treat directories and globs differently.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = join('dist', 'test');
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(dir, name));

if (files.length === 0) {
  console.error(`No test files found in ${dir}. Run "npm run build" first.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
