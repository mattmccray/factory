#!/usr/bin/env bun
// Process entry for the Andon service in the release bundle (scripts/bundle.ts bundles it as the
// bundle's `andon/service.js`); see entry.ts. The bundle is the tree it runs in: it serves the UI
// built into `andon/ui/`, and reports the bundle's own version (its root `package.json`) and its
// `CHANGELOG.md`. The bundle's root is the parent of this file's directory.
import { join } from 'node:path';
import { serve } from './entry';
import { BUNDLE_VERSION_FILE } from './release';

const bundleRoot = join(import.meta.dir, '..');
await serve({ uiDir: join(import.meta.dir, 'ui'), cloneRoot: bundleRoot, versionFile: BUNDLE_VERSION_FILE });
