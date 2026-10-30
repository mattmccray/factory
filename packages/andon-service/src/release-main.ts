#!/usr/bin/env bun
// Process entry for the Andon service in the release bundle (scripts/bundle.ts bundles it as the
// bundle's `andon/service.js`); see entry.ts. The bundle is the tree it runs in (`bundleTree`): it
// serves the UI built into `andon/ui/`, and reports the bundle's own version (its root
// `package.json`) and its `CHANGELOG.md`. The bundle's root is the parent of this file's directory.
// `factory service run` from the bundle's CLI serves the same tree.
import { join } from 'node:path';
import { bundleTree, serve } from './entry';

await serve(bundleTree(join(import.meta.dir, '..')));
