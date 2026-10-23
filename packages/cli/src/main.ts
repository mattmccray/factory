#!/usr/bin/env bun
// Process entry for the factory CLI. The factory root is `<cwd>/factory`: run it from the repo root.
import { join } from 'node:path';
import { run } from './index';

process.exitCode = await run(process.argv.slice(2), {
  root: join(process.cwd(), 'factory'),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
