#!/usr/bin/env bun
// Process entry for the factory CLI in the release bundle (scripts/bundle.ts bundles it as the
// bundle's `bin/factory.js`; `bun add -g github:mattmccray/factory#release` links it as `factory`).
// The same commands as the source CLI (`main.ts`), but `init` and `upgrade` take the installed CLI
// and contract from the bundle's baked `managed/` files, with no source tree, and `--version` says
// `(release)`. The bundle's root is the parent of this file's directory.
import { join } from 'node:path';
import { registryPath } from '@factory/contract';
import { bakedRelease } from './bundle';
import { run } from './index';

process.exitCode = await run(
  process.argv.slice(2),
  {
    root: join(process.cwd(), 'factory'),
    registry: registryPath(process.env.ANDON_HOME), // init registers the project with Andon
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
  { kind: 'release', files: bakedRelease(join(import.meta.dir, '..')) },
);
