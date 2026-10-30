#!/usr/bin/env bun
// Process entry for the Andon service from a source clone (`bun run andon:service`); see entry.ts.
// It serves the Andon UI from this repo's `apps/andon-ui/dist` (built by `bun run andon:ui:build`), and
// reports this repo's release (`packages/templates/package.json`) and `CHANGELOG.md` as its clone's.
import { join } from 'node:path';
import { serve } from './entry';
import { SOURCE_VERSION_FILE } from './release';

const cloneRoot = join(import.meta.dir, '..', '..', '..');
const uiDir = join(cloneRoot, 'apps', 'andon-ui', 'dist');
await serve({ uiDir, cloneRoot, versionFile: SOURCE_VERSION_FILE });
