#!/usr/bin/env bun
// Process entry for the factory CLI in the release bundle (scripts/bundle.ts bundles it as the
// bundle's `bin/factory.js`; `bun add -g github:mattmccray/factory#release` links it as `factory`).
// The same commands as the source CLI (`main.ts`), but `init` and `upgrade` take the installed CLI
// and contract from the bundle's baked `managed/` files, with no source tree, and `--version` says
// `(release)`, and `service run` serves the bundle's Andon service tree (`andon/ui/`, its version and
// CHANGELOG.md). The bundle's root is the parent of this file's directory.
import { join } from 'node:path';
import { peersPath, registryPath } from '@factory/contract';
import { bakedRelease } from './bundle';
import { run } from './index';
import { realServiceHost } from './servicehost';

process.exitCode = await run(
  process.argv.slice(2),
  {
    root: join(process.cwd(), 'factory'),
    registry: registryPath(process.env.ANDON_HOME), // init registers the project with Andon
    peers: peersPath(process.env.ANDON_HOME), // `peers` lists, adds, and removes the Andon peers there
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    service: () => realServiceHost((line) => console.log(line)), // `service` works on this machine's launchd or systemd --user
  },
  { kind: 'release', root: join(import.meta.dir, '..'), files: bakedRelease(join(import.meta.dir, '..')) },
);
