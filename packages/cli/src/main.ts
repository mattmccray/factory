#!/usr/bin/env bun
// Process entry for the factory CLI. The factory root is `<cwd>/factory`: run it from the repo root.
// `init` registers the project in `$ANDON_HOME/projects.json` (default `~/.andon/projects.json`);
// `projects` lists, prunes, and removes the roots registered there.
import { join } from 'node:path';
import { registryPath } from '@factory/contract';
import { run } from './index';

process.exitCode = await run(process.argv.slice(2), {
  root: join(process.cwd(), 'factory'),
  registry: registryPath(process.env.ANDON_HOME), // init registers the project with Andon; projects reads and prunes it
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
