#!/usr/bin/env bun
// Process entry for the factory CLI. The factory root is `<cwd>/factory`: run it from the repo root.
// `init` registers the project in `$ANDON_HOME/projects.json` (default `~/.andon/projects.json`);
// `projects` lists, prunes, and removes the roots registered there, and `peers` the Andon peers in
// `$ANDON_HOME/peers.json`. `service` installs and runs the
// Andon service; `service run` serves this clone's tree.
import { join } from 'node:path';
import { peersPath, registryPath } from '@factory/contract';
import { run } from './index';
import { realServiceHost } from './servicehost';

process.exitCode = await run(process.argv.slice(2), {
  root: join(process.cwd(), 'factory'),
  registry: registryPath(process.env.ANDON_HOME), // init registers the project with Andon; projects reads and prunes it
  peers: peersPath(process.env.ANDON_HOME), // `peers` lists, adds, and removes the Andon peers there
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  service: () => realServiceHost((line) => console.log(line)), // `service` works on this machine's launchd or systemd --user
});
