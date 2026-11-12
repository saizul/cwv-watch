// Extra checks used by "npm run lint" on top of Prettier: no tabs, no trailing
// whitespace, a final newline, and no stray console.log in library code.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const roots = ['src', 'test', 'examples', 'scripts'];
const exts = new Set(['.ts', '.mjs', '.js', '.json', '.md', '.yml']);
const problems = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (exts.has(extname(name))) check(path);
  }
}

function check(path) {
  const text = readFileSync(path, 'utf8');
  if (text.length > 0 && !text.endsWith('\n')) problems.push(`${path}: missing final newline`);
  text.split('\n').forEach((line, i) => {
    if (/\t/.test(line)) problems.push(`${path}:${i + 1}: tab character`);
    if (/[ \t]+$/.test(line)) problems.push(`${path}:${i + 1}: trailing whitespace`);
    if (path.startsWith('src') && /console\.log\(/.test(line) && !path.endsWith('cli.ts')) {
      problems.push(`${path}:${i + 1}: console.log in library code`);
    }
  });
}

for (const root of roots) {
  try {
    walk(root);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} style problem(s).`);
  process.exit(1);
}
console.log('Style check passed.');
