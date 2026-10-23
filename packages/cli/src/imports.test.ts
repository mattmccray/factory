import { expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// AC4: the source CLI depends on the contract only through `@factory/contract`, never on the
// installed copy under factory/ (its lib/ or cli.ts).
const SPECIFIER = /(?:^|\s)(?:import|export)\s(?:[^'"]*?\sfrom\s)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

test('packages/cli imports contract code only from @factory/contract', async () => {
  const files = (await readdir(import.meta.dir, { recursive: true })).filter((f) => f.endsWith('.ts'));
  expect(files).toContain('index.ts');
  const seen: string[] = [];
  for (const f of files) {
    const text = await readFile(join(import.meta.dir, f), 'utf8');
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[1] ?? m[2] ?? '';
      seen.push(spec);
      const allowed = spec === '@factory/contract' || spec === 'bun:test' || spec.startsWith('node:') || /^\.\/[\w.-]+$/.test(spec);
      expect({ file: f, spec, allowed }).toEqual({ file: f, spec, allowed: true });
      expect(spec).not.toContain('factory/lib');
      expect(spec).not.toContain('..');
    }
  }
  expect(seen).toContain('@factory/contract');
});
