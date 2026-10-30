#!/usr/bin/env bun
// Process entry for the Andon service from a source clone; see entry.ts. `factory service run` runs
// the same tree from the source CLI. It serves the Andon UI from this repo's `apps/andon-ui/dist`
// (built by `bun run andon:ui:build`), and reports this repo's release
// (`packages/templates/package.json`) and `CHANGELOG.md` as its clone's.
import { join } from 'node:path';
import { serve, sourceTree } from './entry';

const cloneRoot = join(import.meta.dir, '..', '..', '..');
await serve(sourceTree(cloneRoot));
