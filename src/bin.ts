#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`cwv-watch: ${(err as Error).message}\n`);
    process.exitCode = 3;
  },
);
